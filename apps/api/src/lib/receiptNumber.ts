import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

// Crockford's base-32 alphabet — 0-9 + A-Z minus I, L, O, U. Removes
// characters that read ambiguously when spoken over the phone (I/L/1,
// O/0, U/V), so a client on the line can dictate "SL-X8K3M2P1" without
// second-guessing every character.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CORE_LENGTH = 8;
const PREFIX = "SL-";

/** Public regex — accepts any receipt number the DB could hold. Two
 *  populations exist:
 *    • Newly-generated (post-migration): 8-char Crockford base-32 tail,
 *      no I/L/O/U. Verbal-friendly.
 *    • Backfilled from legacy PDFs: the raw last-8 chars of the
 *      occurrence cuid, uppercased — arbitrary uppercase alphanumeric
 *      (may contain I/L/O/U). Some backfilled rows also carry a
 *      `-N` collision suffix (e.g. "SL-ABCD1234-2") for the rare
 *      cuid-tail collision case.
 *  Prefix is optional and case-insensitive so pasted codes from
 *  emails / phone calls / URL bars all normalize. */
export const RECEIPT_NUMBER_PATTERN = /^(?:SL-)?([0-9A-Z]{8}(?:-\d+)?)$/i;

function makeCore(length: number = CORE_LENGTH): string {
  const buf = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    // Mask to the low 5 bits (0-31) — an unbiased pick from the 32-char
    // alphabet without rejection sampling.
    out += ALPHABET[buf[i] & 31];
  }
  return out;
}

/** Random receipt number with prefix. NOT collision-checked — use
 *  `generateReceiptNumber` for that. */
export function makeReceiptNumber(): string {
  return `${PREFIX}${makeCore()}`;
}

/** Normalize an arbitrary user input (from search box, URL param,
 *  etc.) to canonical `SL-XXXXXXXX` uppercase form. Returns null if
 *  the input isn't shaped like a receipt number. */
export function normalizeReceiptNumber(input: string): string | null {
  const m = input.trim().match(RECEIPT_NUMBER_PATTERN);
  if (!m) return null;
  return `${PREFIX}${m[1].toUpperCase()}`;
}

/** Convert an occurrence id (cuid) to a legacy-format receipt number
 *  matching the pre-migration derivation rule. Used ONLY by the
 *  backfill migration so existing PDFs (which show the last-8-chars-
 *  uppercased of the occurrence id, no prefix) resolve to the same
 *  row after migration. */
export function legacyReceiptNumberFor(occurrenceId: string): string {
  return `${PREFIX}${occurrenceId.slice(-CORE_LENGTH).toUpperCase()}`;
}

/** Generate a receipt number that is not currently taken. Retries a
 *  handful of times on the astronomical off-chance of a collision
 *  (32^8 ≈ 1.1T possible values). Callable inside a Prisma
 *  transaction — pass the tx client so the uniqueness check reads
 *  the in-transaction view. */
export async function generateReceiptNumber(
  tx: Prisma.TransactionClient | { payment: { findUnique: (args: any) => Promise<any> } },
  maxAttempts: number = 5,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = makeReceiptNumber();
    const existing = await tx.payment.findUnique({
      where: { receiptNumber: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error(
    `generateReceiptNumber: exhausted ${maxAttempts} attempts — this should be statistically impossible; investigate the RNG or the Payment table.`,
  );
}
