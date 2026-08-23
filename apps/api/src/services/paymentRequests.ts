import { randomBytes } from "crypto";
import type { Prisma, PaymentCommsMode } from "@prisma/client";
import { prisma } from "../db/prisma";
import { etFormatDateOpts } from "../lib/dates";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { sendSMS, sendEmail } from "../lib/notifications";
import { persistCompletionSplits } from "./payments";

const DEFAULT_BASE_URL = "https://www.seedlings.team";
const DEFAULT_EXPIRY_HOURS = 72;
// A sent-but-unpaid request older than this many days is flagged "stale".
const DEFAULT_STALE_DAYS = 4;
const DEFAULT_COMMS_MODE: PaymentCommsMode = "CLAIMER";

function newToken(): string {
  return randomBytes(16).toString("hex");
}

async function getSetting(key: string): Promise<string | null> {
  const s = await prisma.setting.findUnique({ where: { key } });
  return s?.value ?? null;
}

/**
 * Build the public payment-page URL the client receives. Resolution order:
 *   1. `PAYMENT_REQUEST_BASE_URL` env var (set per-developer in .env).
 *   2. `PAYMENT_REQUEST_BASE_URL` setting in the DB (Settings tab).
 *   3. `http://localhost:3000` when NODE_ENV !== "production".
 *   4. The hard-coded production URL as last-resort fallback.
 *
 * The env-var override exists so a local dev who pulls down a DB
 * snapshot (which has the prod URL seeded) can still get a localhost
 * link in their SMS/email previews without having to mutate the DB.
 */
export async function buildPaymentUrl(token: string): Promise<string> {
  const envBase = process.env.PAYMENT_REQUEST_BASE_URL;
  const settingBase = await getSetting("PAYMENT_REQUEST_BASE_URL");
  const isProd = process.env.NODE_ENV === "production";
  const fallback = isProd ? DEFAULT_BASE_URL : "http://localhost:3000";
  const base = envBase || settingBase || fallback;
  return `${base.replace(/\/+$/, "")}/pay/${token}`;
}

async function computeAmountDue(occurrenceId: string, tx: Prisma.TransactionClient | typeof prisma = prisma): Promise<number> {
  const occ = await tx.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      price: true,
      addons: { select: { price: true } },
    },
  });
  if (!occ) return 0;
  const base = occ.price ?? 0;
  const addons = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
  return base + addons;
}

/**
 * Returns the active **primary** contact for the occurrence's client (or none
 * if the data invariant has been broken). Invoice routing — for both SERVER
 * and CLAIMER modes — is intentionally restricted to the primary so the
 * client always receives a single, predictable touchpoint.
 */
async function getContactsForOccurrence(occurrenceId: string) {
  const occ = await prisma.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      completedAt: true,
      startAt: true,
      job: {
        select: {
          property: {
            select: {
              displayName: true,
              street1: true,
              city: true,
              state: true,
              client: {
                select: {
                  contacts: {
                    // Pull ALL primary contacts regardless of status so
                    // the caller can distinguish "no primary set" from
                    // "primary is PAUSED / ARCHIVED" and produce a
                    // truthful error message. Previously we filtered
                    // ACTIVE at the query, which silently dropped
                    // paused primaries and made the downstream error
                    // ("no primary contact set") lie to the operator.
                    where: { isPrimary: true },
                    select: {
                      id: true, firstName: true, email: true,
                      phone: true, normalizedPhone: true, status: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const primaryContacts = occ?.job?.property?.client?.contacts ?? [];
  // Split ACTIVE (usable) from non-ACTIVE (paused/archived) so callers
  // can pick the right error message. `contacts` retains the ACTIVE-only
  // shape prior callers expect — no behavior change on the happy path.
  const contacts = primaryContacts.filter((c) => c.status === "ACTIVE");
  const inactivePrimary = primaryContacts.find((c) => c.status !== "ACTIVE") ?? null;
  const property = occ?.job?.property ?? null;
  // Service date for the payment-request message body. Prefer completedAt
  // (when the work was finished) over startAt (when it was scheduled). Both
  // can be null on partial occurrences — caller decides the fallback.
  const serviceDate = occ?.completedAt ?? occ?.startAt ?? null;
  return { contacts, inactivePrimary, property, serviceDate };
}

// Property label for client-facing payment messages — prefers the full
// street address so the message identifies the location concretely, falls
// back to the friendly displayName only when no address is on file. This
// matches the formatting used by JobsTab's getQuickMessage() so the
// "Confirm Client" and "Request Payment" wordings stay in lockstep.
function propertyLabel(p: { displayName: string | null; street1: string | null; city: string | null; state: string | null } | null): string {
  if (!p) return "your property";
  const addr = [p.street1, p.city, p.state].filter(Boolean).join(", ");
  if (addr) return addr;
  if (p.displayName) return p.displayName;
  return "your property";
}

// "Thursday, May 28" — same format as the Confirm Client message body.
// ET-anchored: a job completed at 23:30 ET on May 28 is "May 28" to the
// client, not "May 29" (which is what a UTC-locale formatter would emit).
function formatServiceDate(d: Date | null): string {
  if (!d) return "your recent appointment";
  return etFormatDateOpts(new Date(d), {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Replace Unicode characters that SMS carriers commonly mangle (em-dash,
 * en-dash, curly quotes, ellipsis, non-breaking space) with ASCII
 * equivalents. Applied to every SMS body just before it's returned, so
 * NO em-dash can survive into the carrier network — whether it came
 * from a template literal, a property's displayName in the DB, a
 * contact's first name, or any future interpolated source.
 *
 * The mangled form most clients see (`<!- ->` or `<!-- -->`) is the
 * carrier rendering an em-dash byte sequence as if it were HTML.
 */
function smsSafe(body: string): string {
  return body
    .replace(/[—]/g, " - ")    // em-dash → spaced hyphen
    .replace(/[–]/g, "-")      // en-dash → hyphen
    .replace(/[‘’]/g, "'") // curly single quotes → straight
    .replace(/[“”]/g, '"') // curly double quotes → straight
    .replace(/…/g, "...")      // ellipsis → three dots
    .replace(/ /g, " ");       // non-breaking space → regular space
}

function buildSmsBody(firstName: string, propLabel: string, dateStr: string, dollarAmount: string, url: string): string {
  return smsSafe(
    `Hi ${firstName} - your Seedlings lawn care on ${dateStr} at ${propLabel} is complete! Total due: ${dollarAmount}. View your invoice: ${url}`,
  );
}

function buildEmailSubject(dollarAmount: string): string {
  return `Your Seedlings service is complete - ${dollarAmount} due`;
}

function buildEmailBody(firstName: string, propLabel: string, dateStr: string, dollarAmount: string, url: string): string {
  return [
    `Hi ${firstName},`,
    ``,
    `Your Seedlings Lawn Care service on ${dateStr} at ${propLabel} is complete.`,
    ``,
    `Total due: ${dollarAmount}`,
    ``,
    `View your invoice and pay: ${url}`,
    ``,
    `Thanks!`,
    `Seedlings Lawn Care`,
  ].join("\n");
}

// HTML version — shipped as the `html` half of the multipart email so
// modern clients render "View invoice & pay" as a proper clickable
// button instead of the raw pay URL. Text version above is still shipped
// as the `text` half for text-only clients / spam scanners.
//
// Escaping: firstName/propLabel come from ClientContact + Property rows
// entered by staff; we escape defensively regardless.
function buildEmailBodyHtml(firstName: string, propLabel: string, dateStr: string, dollarAmount: string, url: string): string {
  const esc = (s: string) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:16px;line-height:1.5;">
<p>Hi ${esc(firstName)},</p>
<p>Your Seedlings Lawn Care service on ${esc(dateStr)} at ${esc(propLabel)} is complete.</p>
<p><strong>Total due: ${esc(dollarAmount)}</strong></p>
<p style="margin:24px 0;"><a href="${esc(url)}" style="display:inline-block;background:#0a7cff;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">View invoice &amp; pay</a></p>
<p>Thanks!<br>Seedlings Lawn Care</p>
</body></html>`;
}

export const paymentRequests = {
  /**
   * Resolve the effective comms mode for a given claimer (or null when no
   * claimer). The user's per-profile override wins; otherwise the org-wide
   * DEFAULT_PAYMENT_COMMUNICATIONS_MODE setting; otherwise the hard-coded
   * default.
   */
  async resolveCommsMode(claimerUserId: string | null | undefined): Promise<PaymentCommsMode> {
    if (claimerUserId) {
      const u = await prisma.user.findUnique({
        where: { id: claimerUserId },
        select: { paymentCommsMode: true },
      });
      if (u?.paymentCommsMode) return u.paymentCommsMode;
    }
    const raw = await getSetting("DEFAULT_PAYMENT_COMMUNICATIONS_MODE");
    if (raw === "SERVER" || raw === "CLAIMER") return raw;
    return DEFAULT_COMMS_MODE;
  },

  /**
   * Ensure the occurrence has a payment-request token. Returns the token and
   * the prepared SMS/email message bodies so callers can either dispatch
   * server-side (sendForOccurrence) or hand off to a claimer device.
   * No outbound network calls. The dispatch itself is audited by the actor
   * (server send / claimer tap); a token MINT or ROTATION is audited here,
   * because rotating silently kills any pay link already in the client's
   * hands. `currentUserId` is optional so existing callers keep compiling.
   */
  async generateTokenForOccurrence(
    occurrenceId: string,
    opts?: {
      regenerateToken?: boolean;
      // When true, persist promo piggyback deliveries immediately as
      // claimer_pending so the wrapper URL embedded in the returned
      // smsBody/emailBody resolves to a real DB row when the recipient
      // taps it. recordClaimerHandoff later flips those rows to
      // delivered. Without this, the SERVER path (which re-runs
      // per-contact piggyback selection during fanout) still writes
      // deliveries correctly, but the CLAIMER path relies on this
      // early write for click attribution to work.
      writePendingPromoDeliveries?: boolean;
    },
    currentUserId?: string | null,
  ): Promise<{
    token: string;
    url: string;
    amountDue: number;
    propertyLabel: string;
    smsBody: string;
    emailSubject: string;
    emailBody: string;
    contacts: Array<{ id: string; firstName: string | null; phone: string | null; normalizedPhone: string | null; email: string | null }>;
  }> {
    const existing = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { paymentRequestToken: true, paymentRequestTokenCreatedAt: true },
    });
    if (!existing) throw new Error("Occurrence not found");

    // Auto-regenerate when the existing token has aged past the configured
    // expiry. Without this, a re-pay cycle that drags past 72h (or whatever
    // PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS is) would keep firing the same
    // dead token at the client.
    const expiryHours = Number(
      (await getSetting("PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS")) ?? DEFAULT_EXPIRY_HOURS,
    );
    const tokenAgeMs = existing.paymentRequestTokenCreatedAt
      ? Date.now() - existing.paymentRequestTokenCreatedAt.getTime()
      : Infinity;
    const isExpired = tokenAgeMs > expiryHours * 3600 * 1000;

    let token = existing.paymentRequestToken;
    if (!token || isExpired || opts?.regenerateToken) {
      token = newToken();
      const rotated = !!existing.paymentRequestToken;
      const mintedToken = token;
      await prisma.$transaction(async (tx) => {
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: { paymentRequestToken: mintedToken, paymentRequestTokenCreatedAt: new Date() },
        });
        // Money: this token IS the client's pay link. Rotating it invalidates
        // any live link already texted/emailed, so the client can no longer
        // pay through it until a new request goes out. Mirrors the shape of
        // cancelPaymentRequest's "request_canceled" audit.
        await writeAudit(tx, AUDIT.PAYMENT.UPDATED, currentUserId ?? null, {
          occurrenceId,
          action: "request_token_rotated",
          rotated,
          reason: !existing.paymentRequestToken
            ? "first_mint"
            : opts?.regenerateToken
              ? "explicit_regenerate"
              : "expired",
          expiryHours,
          previousTokenCreatedAt:
            existing.paymentRequestTokenCreatedAt?.toISOString() ?? null,
        });
      });
    }

    const url = await buildPaymentUrl(token);
    const amountDue = await computeAmountDue(occurrenceId);
    const { contacts, property, serviceDate } = await getContactsForOccurrence(occurrenceId);
    const propLabel = propertyLabel(property);
    const dateStr = formatServiceDate(serviceDate);
    const dollarAmount = `$${amountDue.toFixed(2)}`;

    // Use the first reachable contact's first name as the SMS/email greeting.
    // (When the server fans out, each contact's own first name is used —
    // generateTokenForOccurrence only returns a representative body for
    // the claimer-handoff icons.)
    const greetingTarget = contacts.find((c) => c.firstName) ?? contacts[0];
    const firstName = greetingTarget?.firstName || "there";

    let smsBody = buildSmsBody(firstName, propLabel, dateStr, dollarAmount, url);
    const emailSubject = buildEmailSubject(dollarAmount);
    let emailBody = buildEmailBody(firstName, propLabel, dateStr, dollarAmount, url);

    // Promo piggyback for the CLAIMER path — the worker's device is
    // about to open `sms:` / `mailto:` with these bodies pre-filled, so
    // we need the promo appended HERE (the actual send happens on the
    // worker's phone, not via Twilio/Resend, so this function is the
    // last chance to compose the outbound message).
    //
    // No PromotionDelivery rows are written here — this function is
    // called by BOTH paths (SERVER internally to mint the token, CLAIMER
    // via /comms-handoff to fetch the body). Server path composes its
    // own message + writes deliveries per-contact after successful
    // Twilio/Resend send; claimer path writes deliveries later via
    // recordClaimerHandoff (best signal we have that the intent fired).
    // Look up the primary contact's clientId + opt-out state via the
    // greeting target — same contact whose firstName leads the body.
    if (greetingTarget?.id) {
      try {
        const contactRow = await prisma.clientContact.findUnique({
          where: { id: greetingTarget.id },
          select: { clientId: true },
        });
        if (contactRow) {
          const { selectPromotionsForPiggyback } = await import("./promotions");
          const mode = opts?.writePendingPromoDeliveries ? "claimer_immediate" : "deferred";
          const smsPiggy = await selectPromotionsForPiggyback({
            contactId: greetingTarget.id,
            clientId: contactRow.clientId,
            channel: "sms",
            triggeredBy: token,
            mode,
          });
          const emailPiggy = await selectPromotionsForPiggyback({
            contactId: greetingTarget.id,
            clientId: contactRow.clientId,
            channel: "email",
            triggeredBy: token,
            mode,
          });
          smsBody += smsPiggy.bodyAppend;
          emailBody += emailPiggy.bodyAppend;
        }
      } catch {
        // Piggyback failures must never block the invoice flow —
        // swallow and ship the base message.
      }
    }

    return { token, url, amountDue, propertyLabel: propLabel, smsBody, emailSubject, emailBody, contacts };
  },

  /**
   * Server-side dispatch path: mint the token (if needed), then fan out to
   * every active contact via Twilio/Resend (SMS preferred). Writes the
   * REQUEST_SENT audit with mode=SERVER. Throws code=NO_CONTACT when there's
   * no reachable contact.
   */
  async sendForOccurrence(
    currentUserId: string,
    occurrenceId: string,
    opts?: { regenerateToken?: boolean },
  ): Promise<{
    smsSent: number;
    emailSent: number;
    failed: number;
    contactsWithoutAddress: number;
    token: string;
    url: string;
  }> {
    const prepared = await this.generateTokenForOccurrence(occurrenceId, opts, currentUserId);
    const { token, url, amountDue, propertyLabel: propLabel, contacts } = prepared;
    // Re-fetch the occurrence's service date for per-contact body building.
    // generateTokenForOccurrence already loaded it via getContactsForOccurrence,
    // but didn't surface it on the return shape — pull it here so each
    // contact's SMS/email carries the same dateStr the claimer-handoff path
    // returned in `prepared.smsBody`.
    const { serviceDate, inactivePrimary } = await getContactsForOccurrence(occurrenceId);
    const dateStr = formatServiceDate(serviceDate);

    if (contacts.length === 0) {
      // Distinguish "no primary at all" from "primary exists but is
      // paused/archived" so the operator knows exactly what to fix.
      // The previous shared error message misled — the operator would
      // set a NEW primary when the real fix was to unpause the existing
      // one. Both branches surface as 409 to keep API contract stable.
      const err: any = new Error(
        inactivePrimary
          ? `Can't send — the primary contact (${inactivePrimary.firstName ?? "unnamed"}) is ${inactivePrimary.status.toLowerCase()}. Unpause them or promote a different contact to primary first.`
          : "This client has no primary contact set. Open the client's contacts and mark one as Primary before sending an invoice.",
      );
      err.code = inactivePrimary ? "PRIMARY_CONTACT_INACTIVE" : "NO_PRIMARY_CONTACT";
      err.statusCode = 409;
      throw err;
    }
    const reachable = contacts.filter((c) => c.phone || c.email);
    if (reachable.length === 0) {
      const err: any = new Error(
        "The primary contact has no phone or email on file. Update their contact info before sending an invoice.",
      );
      err.code = "NO_CONTACT";
      err.statusCode = 409;
      throw err;
    }

    const dollarAmount = `$${amountDue.toFixed(2)}`;
    let smsSent = 0;
    let emailSent = 0;
    let failed = 0;
    let contactsWithoutAddress = 0;

    // Promo piggyback resolution: we need the clientId for the deliveries
    // table. Every contact for a single occurrence belongs to the same
    // client, so one lookup covers the whole loop. Dispatcher is loaded
    // lazily so paymentRequests.ts doesn't pay import cost on every send
    // for orgs that haven't configured a promotion.
    const occForClient = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { job: { select: { property: { select: { clientId: true } } } } },
    });
    const clientId = occForClient?.job?.property?.clientId ?? null;
    const { selectPromotionsForPiggyback } = await import("./promotions");

    for (const c of contacts) {
      const firstName = c.firstName || "there";

      if (c.phone || c.normalizedPhone) {
        // Promo selection BEFORE assembling the outbound body so the
        // dispatcher's cooldown check sees the correct outgoing time.
        // Delivery rows are persisted only if the SMS send succeeds
        // (writeDeliveries called after the ok result) — matches spec
        // requirement that a "delivered" stamp reflects an actual send.
        const piggyback = clientId
          ? await selectPromotionsForPiggyback({
              contactId: c.id,
              clientId,
              channel: "sms",
              triggeredBy: token,
            })
          : { bodyAppend: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
        const smsBody =
          buildSmsBody(firstName, propLabel, dateStr, dollarAmount, url) + piggyback.bodyAppend;
        const phone = c.normalizedPhone ?? c.phone!;
        const result = await sendSMS(phone.startsWith("+") ? phone : `+1${phone.replace(/[^\d]/g, "")}`, smsBody);
        if (result.ok) {
          smsSent++;
          await piggyback.writeDeliveries();
        } else {
          failed++;
        }
      } else if (c.email) {
        const piggyback = clientId
          ? await selectPromotionsForPiggyback({
              contactId: c.id,
              clientId,
              channel: "email",
              triggeredBy: token,
            })
          : { bodyAppend: "", bodyAppendHtml: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
        // Ship both plain-text + HTML halves. HTML renders the invoice
        // CTA as a proper "View invoice & pay" button (hiding the pay
        // URL) and any promo piggyback CTA the same way. Text version
        // is the multipart fallback for text-only clients.
        const textBody = buildEmailBody(firstName, propLabel, dateStr, dollarAmount, url) + piggyback.bodyAppend;
        const htmlBody = buildEmailBodyHtml(firstName, propLabel, dateStr, dollarAmount, url) + (piggyback.bodyAppendHtml ?? "");
        const result = await sendEmail(
          c.email,
          buildEmailSubject(dollarAmount),
          textBody,
          { html: htmlBody },
        );
        if (result.ok) {
          emailSent++;
          await piggyback.writeDeliveries();
        } else {
          failed++;
        }
      } else {
        contactsWithoutAddress++;
      }
    }

    // Stamp the "request sent" timestamp so the job card flips to
    // the in-flight state and Accept Payment is hidden. Without this,
    // the worker could still record cash directly + create a race.
    // paymentRequestFirstSentAt is only stamped on the first send — a
    // conditional update covers both cases in one write (COALESCE
    // preserves the existing value on subsequent sends). The counter
    // increments only when we've sent before.
    const now = new Date();
    await prisma.$executeRaw`
      UPDATE "JobOccurrence"
      SET "paymentRequestSentAt" = ${now},
          "paymentRequestFirstSentAt" = COALESCE("paymentRequestFirstSentAt", ${now}),
          "paymentRequestResendCount" =
            CASE WHEN "paymentRequestFirstSentAt" IS NULL
              THEN 0
              ELSE "paymentRequestResendCount" + 1
            END
      WHERE "id" = ${occurrenceId}
    `;

    await writeAudit(prisma, AUDIT.PAYMENT.REQUEST_SENT, currentUserId, {
      occurrenceId,
      token,
      amount: amountDue,
      mode: "SERVER",
      actor: "server",
      smsSent,
      emailSent,
      failed,
      contactsWithoutAddress,
    });

    return { smsSent, emailSent, failed, contactsWithoutAddress, token, url };
  },

  /**
   * Claimer-side dispatch path: the worker tapped the Text or Email icon on
   * their device, which opened the OS sms:/mailto: handler with our message
   * pre-filled. We can't observe whether they actually hit send — this just
   * records intent so audit shows the handoff. Channel: "sms" | "email".
   */
  async recordClaimerHandoff(
    currentUserId: string,
    occurrenceId: string,
    channel: "sms" | "email",
    completionSplits?: Array<{ userId: string; percent: number }>,
  ): Promise<void> {
    if (channel !== "sms" && channel !== "email") {
      throw new Error(`Invalid channel: ${channel}`);
    }
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { paymentRequestToken: true },
      });
      if (!occ?.paymentRequestToken) {
        throw new Error("Occurrence has no payment-request token");
      }
      // Persist worker percentages + re-snapshot promisedPayouts when the
      // claimer set splits in the Take Payment dialog. This is the same
      // canonical write path used by createPayment (Accept Now).
      if (Array.isArray(completionSplits) && completionSplits.length > 0) {
        await persistCompletionSplits(tx, occurrenceId, completionSplits, currentUserId);
      }
      // Stamp the "request sent" timestamp so the job card flips to
      // in-flight state (hides Accept Payment, exposes Re-send + Cancel).
      // Same first-sent / resend-count semantics as sendForOccurrence —
      // first tap seeds paymentRequestFirstSentAt; subsequent taps
      // bump the counter. See that method for the rationale.
      const now = new Date();
      await tx.$executeRaw`
        UPDATE "JobOccurrence"
        SET "paymentRequestSentAt" = ${now},
            "paymentRequestFirstSentAt" = COALESCE("paymentRequestFirstSentAt", ${now}),
            "paymentRequestResendCount" =
              CASE WHEN "paymentRequestFirstSentAt" IS NULL
                THEN 0
                ELSE "paymentRequestResendCount" + 1
              END
        WHERE "id" = ${occurrenceId}
      `;
      const amount = await computeAmountDue(occurrenceId);
      await writeAudit(tx, AUDIT.PAYMENT.REQUEST_SENT, currentUserId, {
        occurrenceId,
        token: occ.paymentRequestToken,
        amount,
        mode: "CLAIMER",
        actor: "claimer",
        channel,
        splitsSet: !!(completionSplits && completionSplits.length > 0),
      });

      // Promo piggyback: flip pre-persisted claimer_pending rows for the
      // primary contact + this channel to delivered. The rows were
      // written by generateTokenForOccurrence(writePendingPromoDeliveries:true)
      // at /comms-handoff fetch time, using the same deliveryIds that
      // were embedded in the outbound SMS/email wrapper URLs.
      //
      // Do NOT re-run selectPromotionsForPiggyback here — that would
      // generate fresh deliveryIds that don't match the URL the
      // recipient actually has, breaking click attribution. (This was
      // the shipped-bug pattern before this fix.)
      try {
        await tx.promotionDelivery.updateMany({
          where: {
            triggeredBy: occ.paymentRequestToken,
            channel,
            skippedReason: "claimer_pending",
            deliveredAt: null,
          },
          data: {
            deliveredAt: new Date(),
            skippedReason: null,
          },
        });
      } catch {
        // Attribution flip failures must never block the invoice audit.
      }
    });
  },

  /**
   * Cancel an in-flight payment request. Regenerates the token (so the
   * client's old SMS link starts returning "Payment link not valid")
   * and clears paymentRequestSentAt so the worker can pick a different
   * path (Accept Payment for cash, or re-send Request later).
   *
   * Refuses if a Payment row already exists for the occurrence — at
   * that point the worker should go through admin Reject instead.
   */
  async cancelPaymentRequest(currentUserId: string, occurrenceId: string): Promise<void> {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { paymentRequestSentAt: true, payment: { select: { id: true } } },
      });
      if (!occ) throw new Error("Occurrence not found");
      if (occ.payment) {
        const err: any = new Error(
          "Payment was already recorded for this occurrence. Reject it from Pending Approvals first.",
        );
        err.code = "PAYMENT_EXISTS";
        throw err;
      }
      const newTok = newToken();
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          paymentRequestToken: newTok,
          paymentRequestTokenCreatedAt: new Date(),
          paymentRequestSentAt: null,
          // Cancel is a "start the request cycle over" action — clear
          // the historical first-sent time and reset the resend counter
          // so the next send begins a fresh cycle.
          paymentRequestFirstSentAt: null,
          paymentRequestResendCount: 0,
        },
      });
      await writeAudit(tx, AUDIT.PAYMENT.UPDATED, currentUserId, {
        occurrenceId,
        action: "request_canceled",
        // Token was regenerated — the old SMS/email link is now invalid.
      });
    });
  },

  async resolveToken(token: string): Promise<{
    occurrenceId: string;
    amountDue: number;
    propertyLabel: string;
    propertyAddress: string | null;
    serviceDate: Date | null;
    jobTags: string | null;
    payment: {
      id: string;
      method: string;
      amountPaid: number;
      confirmed: boolean;
      selfReported: boolean;
      createdAt: Date;
    } | null;
    photos: Array<{ id: string; r2Key: string; contentType: string | null }>;
    expiresAt: Date | null;
  } | null> {
    const occ = await prisma.jobOccurrence.findFirst({
      where: { paymentRequestToken: token },
      select: {
        id: true,
        paymentRequestTokenCreatedAt: true,
        startAt: true,
        completedAt: true,
        jobTags: true,
        price: true,
        addons: { select: { price: true } },
        job: {
          select: {
            property: {
              select: {
                displayName: true,
                street1: true,
                city: true,
                state: true,
              },
            },
          },
        },
        payment: {
          select: {
            id: true,
            method: true,
            amountPaid: true,
            confirmed: true,
            selfReported: true,
            createdAt: true,
          },
        },
        photos: {
          select: { id: true, r2Key: true, contentType: true },
          // Upload order (createdAt asc) — matches the Community feed
          // (public.ts /public/feed) so a client sees the same photo
          // sequence on both surfaces. When the row exceeds the take
          // cap, the OLDEST photos are kept; newer ones drop off.
          // If future scale means late-uploads should win instead,
          // switch to desc but also update the feed to match.
          orderBy: { createdAt: "asc" },
          take: 15,
        },
      },
    });
    if (!occ) return null;

    const expiryHours = Number((await getSetting("PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS")) ?? DEFAULT_EXPIRY_HOURS);
    const created = occ.paymentRequestTokenCreatedAt;
    const expiresAt = created ? new Date(created.getTime() + expiryHours * 3600 * 1000) : null;
    if (expiresAt && Date.now() > expiresAt.getTime()) return null;

    const base = occ.price ?? 0;
    const addons = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
    const amountDue = base + addons;

    const prop = occ.job?.property ?? null;
    const propLabel = propertyLabel(prop);
    const propAddress = prop
      ? [prop.street1, prop.city, prop.state].filter(Boolean).join(", ") || null
      : null;

    return {
      occurrenceId: occ.id,
      amountDue,
      propertyLabel: propLabel,
      propertyAddress: propAddress,
      serviceDate: occ.completedAt ?? occ.startAt ?? null,
      jobTags: occ.jobTags ?? null,
      payment: occ.payment,
      photos: occ.photos,
      expiresAt,
    };
  },

  async recordTokenAccess(occurrenceId: string, ip?: string | null) {
    await prisma.auditEvent.create({
      data: {
        scope: AUDIT.PAYMENT.TOKEN_ACCESSED[0],
        verb: AUDIT.PAYMENT.TOKEN_ACCESSED[1],
        action: `${AUDIT.PAYMENT.TOKEN_ACCESSED[0]}_${AUDIT.PAYMENT.TOKEN_ACCESSED[1]}`,
        actorUserId: null,
        metadata: { occurrenceId, ip: ip ?? null } as any,
      },
    });
  },

  /**
   * Outstanding payment requests — jobs where a request was sent to the
   * client but no payment has come back yet. These are receivables that can
   * otherwise be silently forgotten. `stale` flags requests older than the
   * PAYMENT_REQUEST_STALE_DAYS threshold; `linkExpired` flags ones whose
   * pay link has lapsed (the client can no longer pay even if they try).
   * With `claimerUserId`, scoped to one worker's own claimed jobs.
   */
  async listOutstanding(opts?: { claimerUserId?: string; cutoff?: Date | null }) {
    const expiryHours = Number(
      (await getSetting("PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS")) ?? DEFAULT_EXPIRY_HOURS,
    );
    const staleDays = Number(
      (await getSetting("PAYMENT_REQUEST_STALE_DAYS")) ?? DEFAULT_STALE_DAYS,
    );
    // Business Start Date filter — pre-cutoff outstanding requests hidden
    // when the cutoff is engaged. Anchored on paymentRequestSentAt (the
    // operational "we asked the client" date). See lib/businessStartCutoff.ts.
    const cutoff = opts?.cutoff ?? null;
    const occs = await prisma.jobOccurrence.findMany({
      where: {
        status: "PENDING_PAYMENT",
        paymentRequestSentAt: cutoff
          ? { not: null, gte: cutoff }
          : { not: null },
        // No payment recorded yet — once the client pays, it moves to the
        // approval queue and is no longer "awaiting client payment".
        payment: { is: null },
        ...(opts?.claimerUserId
          ? {
              assignees: {
                // SQL NULL-safety on role (see equipment.ts comment).
                some: {
                  userId: opts.claimerUserId,
                  OR: [{ role: null }, { role: { not: "observer" } }],
                },
              },
            }
          : {}),
      },
      orderBy: { paymentRequestSentAt: "asc" },
      select: {
        id: true,
        startAt: true,
        price: true,
        paymentRequestSentAt: true,
        paymentRequestFirstSentAt: true,
        paymentRequestResendCount: true,
        paymentRequestToken: true,
        paymentRequestTokenCreatedAt: true,
        // Reconciliation hint — the payment method key + timestamp
        // the client last tapped on the /pay/[token] page. Feeds
        // the "Tapped X" chip on the Awaiting-payment card so the
        // operator knows where to look when tracking down whether
        // the client actually paid. See JobOccurrence.paymentIntentMethod.
        paymentIntentMethod: true,
        paymentIntentAt: true,
        addons: { select: { price: true } },
        job: {
          select: {
            id: true,
            property: {
              select: {
                displayName: true,
                // Street address surfaced on the card so the operator
                // can identify WHICH property when displayName is a
                // nickname like "Home".
                street1: true,
                city: true,
                state: true,
                client: {
                  select: {
                    displayName: true,
                    // Every active contact on the client — surfaced on
                    // the card so the operator can match a spouse /
                    // roommate / different-last-name payer to this
                    // property when reconciling a Zelle/Venmo/bank
                    // record. Primary first so the "main" contact is
                    // most prominent.
                    contacts: {
                      where: { status: "ACTIVE" },
                      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        nickname: true,
                        phone: true,
                        email: true,
                        isPrimary: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        assignees: {
          // SQL NULL-safety on role (see equipment.ts comment).
          where: { OR: [{ role: null }, { role: { not: "observer" } }] },
          select: {
            userId: true,
            assignedById: true,
            user: { select: { displayName: true, email: true } },
          },
        },
      },
    });
    // Build the public invoice URL up-front for every row that still
    // has a live token, so the worklist can render a clickable link
    // without a per-row fetch. The base URL is resolved once.
    const invoiceUrls = new Map<string, string>();
    await Promise.all(
      occs
        .filter((o) => !!o.paymentRequestToken)
        .map(async (o) => {
          invoiceUrls.set(o.id, await buildPaymentUrl(o.paymentRequestToken!));
        }),
    );
    const now = Date.now();
    // date-handling-allow: elapsed-time — "days since requested" for a
    // display label (e.g. "Requested 3 days ago"). ≤1-hour DST drift
    // doesn't matter for a human-readable bucket count.
    const dayMs = 86_400_000;
    return occs.map((o) => {
      const requestedAt = o.paymentRequestSentAt!;
      const daysSinceRequested = Math.floor((now - requestedAt.getTime()) / dayMs);
      // First-sent history: for legacy rows the backfill seeded this from
      // sentAt, so it's non-null in practice for anything in this list.
      // The nullish fallback keeps the type honest for any edge case.
      const firstSentAt = o.paymentRequestFirstSentAt ?? requestedAt;
      const daysSinceFirstSent = Math.floor((now - firstSentAt.getTime()) / dayMs);
      const linkExpiresAt = o.paymentRequestTokenCreatedAt
        ? new Date(o.paymentRequestTokenCreatedAt.getTime() + expiryHours * 3_600_000)
        : null;
      const claimer = o.assignees.find((a) => a.assignedById === a.userId) ?? null;
      const amount =
        (o.price ?? 0) + o.addons.reduce((s, a) => s + (a.price ?? 0), 0);
      return {
        occurrenceId: o.id,
        startAt: o.startAt,
        requestedAt,
        daysSinceRequested,
        firstSentAt,
        daysSinceFirstSent,
        resendCount: o.paymentRequestResendCount ?? 0,
        stale: daysSinceRequested >= staleDays,
        linkExpiresAt,
        linkExpired: linkExpiresAt ? linkExpiresAt.getTime() < now : false,
        amount,
        jobId: o.job?.id ?? null,
        property: o.job?.property?.displayName ?? null,
        propertyAddress: o.job?.property
          ? {
              displayName: o.job.property.displayName,
              street1: o.job.property.street1,
              city: o.job.property.city,
              state: o.job.property.state,
            }
          : null,
        client: o.job?.property?.client?.displayName ?? null,
        contacts: (o.job?.property?.client?.contacts ?? []).map((c) => ({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          nickname: c.nickname,
          phone: c.phone,
          email: c.email,
          isPrimary: c.isPrimary,
        })),
        // Fully-resolved public invoice page URL. Null when the token
        // is missing entirely (shouldn't happen for rows in this list —
        // they all have paymentRequestSentAt — but we keep the type
        // honest for any edge case).
        invoiceUrl: invoiceUrls.get(o.id) ?? null,
        claimer: claimer?.user
          ? {
              id: claimer.userId,
              displayName: claimer.user.displayName,
              email: claimer.user.email,
            }
          : null,
        paymentIntentMethod: o.paymentIntentMethod,
        paymentIntentAt: o.paymentIntentAt,
      };
    });
  },
};
