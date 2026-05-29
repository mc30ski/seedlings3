"use client";

import { apiGet } from "@/src/lib/api";

const SETTING_KEY = "OUTGOING_COMMS_CC";

export type CommsCc = {
  emails: string[];
  phones: string[];
};

const EMPTY_CC: CommsCc = { emails: [], phones: [] };

export function parseCommsCc(raw: string | null | undefined): CommsCc {
  if (!raw) return EMPTY_CC;
  try {
    const parsed = JSON.parse(raw);
    const emails = Array.isArray(parsed?.emails)
      ? parsed.emails
          .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s: string) => s.trim())
      : [];
    const phones = Array.isArray(parsed?.phones)
      ? parsed.phones
          .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s: string) => s.trim())
      : [];
    return { emails, phones };
  } catch {
    return EMPTY_CC;
  }
}

/**
 * Fetches the current OUTGOING_COMMS_CC setting fresh from the API. Call
 * this inside the click handler that is about to open an sms:/mailto: link
 * — no caching, no hooks, no event bus to keep in sync. The cost is one
 * lightweight GET right before the user's tap fires the device handler;
 * on failure we silently fall back to empty so the comm still goes out
 * (just without CCs) instead of blocking the user.
 *
 * Org policy is no silent BCC — both lists are added as visible recipients.
 */
export async function fetchCommsCc(): Promise<CommsCc> {
  try {
    const rows = await apiGet<Array<{ key: string; value: string }>>("/api/settings");
    if (!Array.isArray(rows)) return EMPTY_CC;
    const row = rows.find((r) => r.key === SETTING_KEY);
    return parseCommsCc(row?.value ?? null);
  } catch {
    return EMPTY_CC;
  }
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Dedup key for phone numbers. Digits-only with a leading US country code
 * stripped when present, so "+1 555-123-4567" and "5551234567" hash to the
 * same value. Non-US numbers stay verbatim digits — still works for dedup
 * as long as the user enters them consistently. Exported so the Settings
 * editor uses the same match logic that the send-time helper does.
 */
export function phoneKey(s: string): string {
  const digits = (s ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Dedup key for emails: lowercased + trimmed. */
export function emailKey(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Drop entries from `extras` that normalize-match either `primary` or any
 * earlier entry in the list. The first occurrence of any key wins, so the
 * original casing/formatting from earlier in the list is preserved.
 */
function dedupRecipients(
  primary: string,
  extras: string[],
  key: (s: string) => string,
): string[] {
  const seen = new Set<string>();
  const primaryKey = key(primary);
  if (primaryKey) seen.add(primaryKey);
  const out: string[] = [];
  for (const v of extras) {
    if (!v) continue;
    const k = key(v);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Builds an sms: deep link. Recipient first, CC phones appended as
 * additional recipients — on iOS/Android this opens as a group thread the
 * client can see. Honors the iOS &body= / Android ?body= separator quirk.
 */
export function buildSmsHref(opts: { to: string; body?: string; ccPhones?: string[] }): string {
  const cc = dedupRecipients(opts.to, opts.ccPhones ?? [], phoneKey);
  const recipients = [opts.to, ...cc].filter((p) => p && p.length > 0);
  const target = recipients.join(",");
  if (!opts.body) return `sms:${target}`;
  const sep = isIOS() ? "&" : "?";
  return `sms:${target}${sep}body=${encodeURIComponent(opts.body)}`;
}

/**
 * Builds a mailto: deep link with cc= populated from the CC list. CC is
 * visible to the recipient by design — the org policy is no silent BCC.
 */
export function buildMailtoHref(opts: {
  to: string;
  subject?: string;
  body?: string;
  ccEmails?: string[];
}): string {
  const cc = dedupRecipients(opts.to, opts.ccEmails ?? [], emailKey);
  const params: string[] = [];
  if (cc.length > 0) {
    params.push(`cc=${encodeURIComponent(cc.join(","))}`);
  }
  if (opts.subject) params.push(`subject=${encodeURIComponent(opts.subject)}`);
  if (opts.body) params.push(`body=${encodeURIComponent(opts.body)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return `mailto:${opts.to}${qs}`;
}
