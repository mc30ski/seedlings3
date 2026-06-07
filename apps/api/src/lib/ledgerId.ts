// Accounting-system-agnostic ledger ID generator.
//
// Format: SLC-YYMMDD-XXXX  (14 chars; well under the 21-char QB limit)
//   SLC    — fixed prefix (Seedlings Lawn Care)
//   YYMMDD — ET-calendar creation date (matches the rest of the app's
//            America/New_York date conventions)
//   XXXX   — 4 random uppercase alphanumeric chars (CSPRNG-sourced)
//
// Stamped at row creation on Payment, Checkout, BusinessExpense, and
// GuaranteedPayoutAdvance. Used as the QuickBooks JournalNo on export.
// PaymentSplit and CheckoutSplit JournalNos derive at export time from
// their parent's ledgerId + a user suffix — no per-split column.

import { randomInt } from "crypto";
import { etFormatDate } from "./dates";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 chars

function etYyMmDd(date: Date): string {
  // YYYY-MM-DD in ET → YYMMDD. Goes through the canonical etFormatDate
  // helper so this stays consistent with the rest of the codebase
  // (e.g. if America/New_York is ever swapped for another timezone,
  // it's a one-line change in lib/dates.ts).
  const [y, m, d] = etFormatDate(date).split("-");
  return `${y.slice(2)}${m}${d}`;
}

export function generateLedgerId(date: Date = new Date()): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += ALPHABET[randomInt(0, ALPHABET.length)];
  return `SLC-${etYyMmDd(date)}-${suffix}`;
}
