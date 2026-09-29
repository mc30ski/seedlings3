// ─────────────────────────────────────────────────────────────────────────────
// What a visit is worth, and what the crew shares in — the three totals.
//
// Canonical spec: docs/features/job-materials.md
//
//   LABOR + SERVICES  the raw base — labor plus any add-on work.
//   INVOICE TOTAL     what the client owes: the base PLUS material charges,
//                     which are billed on top.
//   CREW POOL         what the crew splits: the base. Materials never enter
//                     it; the client pays for them separately.
//
// THESE LIVE HERE, IN THE SHARED PACKAGE, FOR ONE REASON. They used to be
// API-only, so every web surface that needed an invoice total re-derived it
// by hand — and each one wrote `price + addons`, silently dropping the
// materials. Four copies, all wrong the same way. The approval dialog then
// showed a client who had paid their invoice in full as having OVERPAID by
// exactly the material charges, and offered to hand that money to the crew
// as a tip. The accept dialog made the opposite error, pre-filling an
// under-collection.
//
// The server was never wrong: it derives the pool as `collected − charges`
// from its own data. Only the screens were. So the fix is not a better
// comment — it is making the correct number importable from both sides.
//
// DO NOT REINTRODUCE A BRANCH HERE. There was a pricingModel enum once;
// nineteen call sites had to ask which era a row belonged to and six forgot.
// Migration 20260908090000 rewrote the data so one rule covers every row.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape any caller must supply. Structural rather than a Prisma type, so
 *  a partial `select` and the web's own row types both satisfy it.
 *
 *  EVERY FIELD IS OPTIONAL, AND THAT IS A KNOWN WEAKNESS. Forgetting to
 *  select `invoiceCharges` does not fail to compile — it silently returns a
 *  smaller invoice, which is precisely the bug this module was extracted to
 *  fix. Structural typing never caught it either, because `addons` and
 *  `invoiceCharges` were already optional. The real guard is the build gate
 *  asserting that the payment-approval select fetches the lines; do not
 *  delete that rule believing the types cover it. */
export type PricedOccurrence = {
  price?: number | null;
  addons?: Array<{ price: number | null }> | null;
  /** The client's invoice lines. `cost` is the CHARGE — see
   *  InvoiceCharge.cost in the schema. */
  invoiceCharges?: Array<{ cost: number }> | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Add-ons are extra WORK, so they are in the pool. The distinction that
 *  matters is work vs materials, never service vs charge. */
export function addonTotal(occ: PricedOccurrence): number {
  return round2((occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0));
}

/** Material lines, at what the CLIENT is charged. */
export function materialChargeTotal(occ: PricedOccurrence): number {
  return round2((occ.invoiceCharges ?? []).reduce((s, e) => s + (e.cost ?? 0), 0));
}

/**
 * Labor plus the work add-ons. The base the other two are built from, and by
 * itself the answer to neither question.
 */
export function laborAndServices(occ: PricedOccurrence): number {
  return round2((occ.price ?? 0) + addonTotal(occ));
}

/**
 * What the crew splits, before margin and per-worker fees.
 *
 * Labor plus the work add-ons — materials are billed to the client on top and
 * never touch it. Verify against the payout engine, which is authoritative:
 * `computeBreakdown(collected, charges, …)` computes `N = collected − charges`,
 * so feeding it the itemized invoice yields exactly this figure.
 *
 *   collected = 160, charges = 60  →  the crew is paid 100.
 *
 * The build gate asserts this against `computeBreakdown` rather than against a
 * hand-typed number, because a typed number is how the last bug here got
 * locked in.
 */
export function crewPool(occ: PricedOccurrence): number {
  return laborAndServices(occ);
}

/**
 * What the client owes: the work, plus the materials billed on top.
 */
export function invoiceTotal(occ: PricedOccurrence): number {
  return round2(laborAndServices(occ) + materialChargeTotal(occ));
}

/** What we actually paid for the materials on this visit, where it is known.
 *  Informational only — never in the invoice, never in the payout. */
export function materialCostTotal(
  occ: { invoiceCharges?: Array<{ actualCost?: number | null }> | null },
): number {
  return round2((occ.invoiceCharges ?? []).reduce((s, e) => s + (e.actualCost ?? 0), 0));
}
