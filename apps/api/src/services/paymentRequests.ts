import { randomBytes } from "crypto";
import type { Prisma, PaymentCommsMode } from "@prisma/client";
import { prisma } from "../db/prisma";
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
async function buildPaymentUrl(token: string): Promise<string> {
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

async function getContactsForOccurrence(occurrenceId: string) {
  const occ = await prisma.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
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
                    where: { status: "ACTIVE" },
                    select: { id: true, firstName: true, email: true, phone: true, normalizedPhone: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const contacts = occ?.job?.property?.client?.contacts ?? [];
  const property = occ?.job?.property ?? null;
  return { contacts, property };
}

function propertyLabel(p: { displayName: string | null; street1: string | null; city: string | null; state: string | null } | null): string {
  if (!p) return "your property";
  if (p.displayName) return p.displayName;
  const parts = [p.street1, p.city, p.state].filter(Boolean);
  return parts.join(", ") || "your property";
}

function buildSmsBody(firstName: string, propLabel: string, dollarAmount: string, url: string): string {
  return `Hi ${firstName} — your Seedlings lawn care at ${propLabel} is complete! Total due: ${dollarAmount}. View your invoice: ${url}`;
}

function buildEmailSubject(dollarAmount: string): string {
  return `Your Seedlings service is complete — ${dollarAmount} due`;
}

function buildEmailBody(firstName: string, propLabel: string, dollarAmount: string, url: string): string {
  return [
    `Hi ${firstName},`,
    ``,
    `Your Seedlings Lawn Care service at ${propLabel} is complete.`,
    ``,
    `Total due: ${dollarAmount}`,
    ``,
    `View your invoice and pay: ${url}`,
    ``,
    `Thanks!`,
    `Seedlings Lawn Care`,
  ].join("\n");
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
   * No outbound network calls. No audit row — auditing belongs to the actor
   * (server send / claimer tap), not the token mint.
   */
  async generateTokenForOccurrence(
    occurrenceId: string,
    opts?: { regenerateToken?: boolean },
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
      await prisma.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { paymentRequestToken: token, paymentRequestTokenCreatedAt: new Date() },
      });
    }

    const url = await buildPaymentUrl(token);
    const amountDue = await computeAmountDue(occurrenceId);
    const { contacts, property } = await getContactsForOccurrence(occurrenceId);
    const propLabel = propertyLabel(property);
    const dollarAmount = `$${amountDue.toFixed(2)}`;

    // Use the first reachable contact's first name as the SMS/email greeting.
    // (When the server fans out, each contact's own first name is used —
    // generateTokenForOccurrence only returns a representative body for
    // the claimer-handoff icons.)
    const greetingTarget = contacts.find((c) => c.firstName) ?? contacts[0];
    const firstName = greetingTarget?.firstName || "there";

    const smsBody = buildSmsBody(firstName, propLabel, dollarAmount, url);
    const emailSubject = buildEmailSubject(dollarAmount);
    const emailBody = buildEmailBody(firstName, propLabel, dollarAmount, url);

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
    const prepared = await this.generateTokenForOccurrence(occurrenceId, opts);
    const { token, url, amountDue, propertyLabel: propLabel, contacts } = prepared;

    const reachable = contacts.filter((c) => c.phone || c.email);
    if (reachable.length === 0) {
      const err: any = new Error("No reachable contacts");
      err.code = "NO_CONTACT";
      throw err;
    }

    const dollarAmount = `$${amountDue.toFixed(2)}`;
    let smsSent = 0;
    let emailSent = 0;
    let failed = 0;
    let contactsWithoutAddress = 0;

    for (const c of contacts) {
      const firstName = c.firstName || "there";

      if (c.phone || c.normalizedPhone) {
        const smsBody = buildSmsBody(firstName, propLabel, dollarAmount, url);
        const phone = c.normalizedPhone ?? c.phone!;
        const result = await sendSMS(phone.startsWith("+") ? phone : `+1${phone.replace(/[^\d]/g, "")}`, smsBody);
        if (result.ok) smsSent++;
        else failed++;
      } else if (c.email) {
        const result = await sendEmail(
          c.email,
          buildEmailSubject(dollarAmount),
          buildEmailBody(firstName, propLabel, dollarAmount, url),
        );
        if (result.ok) emailSent++;
        else failed++;
      } else {
        contactsWithoutAddress++;
      }
    }

    // Stamp the "request sent" timestamp so the job card flips to
    // the in-flight state and Accept Payment is hidden. Without this,
    // the worker could still record cash directly + create a race.
    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: { paymentRequestSentAt: new Date() },
    });

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
        await persistCompletionSplits(tx, occurrenceId, completionSplits);
      }
      // Stamp the "request sent" timestamp so the job card flips to
      // in-flight state (hides Accept Payment, exposes Re-send + Cancel).
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { paymentRequestSentAt: new Date() },
      });
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
          orderBy: { createdAt: "desc" },
          take: 6,
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
  async listOutstanding(opts?: { claimerUserId?: string }) {
    const expiryHours = Number(
      (await getSetting("PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS")) ?? DEFAULT_EXPIRY_HOURS,
    );
    const staleDays = Number(
      (await getSetting("PAYMENT_REQUEST_STALE_DAYS")) ?? DEFAULT_STALE_DAYS,
    );
    const occs = await prisma.jobOccurrence.findMany({
      where: {
        status: "PENDING_PAYMENT",
        paymentRequestSentAt: { not: null },
        // No payment recorded yet — once the client pays, it moves to the
        // approval queue and is no longer "awaiting client payment".
        payment: { is: null },
        ...(opts?.claimerUserId
          ? {
              assignees: {
                some: { userId: opts.claimerUserId, role: { not: "observer" } },
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
        paymentRequestTokenCreatedAt: true,
        addons: { select: { price: true } },
        job: {
          select: {
            id: true,
            property: {
              select: {
                displayName: true,
                client: { select: { displayName: true } },
              },
            },
          },
        },
        assignees: {
          where: { role: { not: "observer" } },
          select: {
            userId: true,
            assignedById: true,
            user: { select: { displayName: true, email: true } },
          },
        },
      },
    });
    const now = Date.now();
    const dayMs = 86_400_000;
    return occs.map((o) => {
      const requestedAt = o.paymentRequestSentAt!;
      const daysSinceRequested = Math.floor((now - requestedAt.getTime()) / dayMs);
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
        stale: daysSinceRequested >= staleDays,
        linkExpiresAt,
        linkExpired: linkExpiresAt ? linkExpiresAt.getTime() < now : false,
        amount,
        jobId: o.job?.id ?? null,
        property: o.job?.property?.displayName ?? null,
        client: o.job?.property?.client?.displayName ?? null,
        claimer: claimer?.user
          ? {
              id: claimer.userId,
              displayName: claimer.user.displayName,
              email: claimer.user.email,
            }
          : null,
      };
    });
  },
};
