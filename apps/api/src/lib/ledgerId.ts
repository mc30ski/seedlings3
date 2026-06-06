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

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 chars

function etYyMmDd(date: Date): string {
  // en-CA gives YYYY-MM-DD; slice off the century.
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).split("-");
  return `${y.slice(2)}${m}${d}`;
}

export function generateLedgerId(date: Date = new Date()): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += ALPHABET[randomInt(0, ALPHABET.length)];
  return `SLC-${etYyMmDd(date)}-${suffix}`;
}
