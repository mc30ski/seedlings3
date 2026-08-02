// Client-side helpers for the SL-XXXXXXXX receipt number format.
// Mirrors apps/api/src/lib/receiptNumber.ts's pattern + normalizer
// — kept in sync by hand. Generation lives server-side only.
//
// The alphabet is Crockford base-32 (0-9 + A-Z minus I, L, O, U) so
// the regex character class matches only chars the generator can emit.

// Loose alphabet — see apps/api/src/lib/receiptNumber.ts for the
// rationale. Accepts both newly-generated (Crockford, no I/L/O/U)
// and backfilled (raw cuid tail, any uppercase alphanumeric) values,
// with an optional `-N` collision suffix.
export const RECEIPT_NUMBER_PATTERN = /^(?:SL-)?([0-9A-Z]{8}(?:-\d+)?)$/i;

/** Normalize an arbitrary user input (from search box, pasted URL,
 *  etc.) to canonical `SL-XXXXXXXX` uppercase form. Returns null if
 *  the input isn't shaped like a receipt number — call sites use
 *  that as the "not a receipt lookup, fall through to normal search"
 *  signal. */
export function normalizeReceiptNumber(input: string): string | null {
  const m = input.trim().match(RECEIPT_NUMBER_PATTERN);
  if (!m) return null;
  return `SL-${m[1].toUpperCase()}`;
}
