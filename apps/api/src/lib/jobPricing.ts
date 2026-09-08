// ─────────────────────────────────────────────────────────────────────────────
// What a visit is worth, and what the crew shares in
//
// Canonical spec: docs/features/job-materials.md
//
// THREE NUMBERS:
//
//   LABOR + SERVICES  the raw base — labor plus any add-on work.
//   INVOICE TOTAL     what the client owes: the base plus the material
//                     charges, which are billed on top.
//   CREW POOL         what the crew splits: the base. Materials never enter
//                     it; the client pays for them separately.
//
// ONE MODEL, ALWAYS. There was a `pricingModel` enum (LEGACY | ITEMIZED)
// because historical visits never billed their materials — a $100 mow with
// $60 of mulch invoiced $100 and paid the crew out of $40. Reproducing that
// needed a rule that travelled with the row, so every money calculation
// branched: nineteen sites across eight files, and the same "forgot to
// branch" bug shipped in six of them.
//
// It was never necessary. Both facts are reproducible by rewriting the data —
// set the stored price to `base − charges` and the single rule below produces
// the same invoice and the same pool. Migration 20260908090000 did exactly
// that (nine rows in production, none lossy) and dropped the column.
//
// DO NOT REINTRODUCE A BRANCH HERE. If a future rule really must differ by
// era, change the data to fit one rule rather than teaching nineteen call
// sites to ask which era they are in.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape any caller must supply. Deliberately structural rather than a
 *  Prisma type, so a partial `select` satisfies it and the compiler tells you
 *  when you forgot to fetch the lines. */
export type PricedOccurrence = {
  price: number | null;
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
  occ: { invoiceCharges?: Array<{ actualCost: number | null }> | null },
): number {
  return round2((occ.invoiceCharges ?? []).reduce((s, e) => s + (e.actualCost ?? 0), 0));
}

// ── Client-facing labels ─────────────────────────────────────────────────────

/**
 * Last-resort prettifier for a service key with no catalog entry.
 *
 * "LEAF_CLEANUP" → "Leaf cleanup", not "Leaf_cleanup". A naive
 * `charAt(0) + slice(1).toLowerCase()` only handles single-word tags, which is
 * how an underscored key reached a client's invoice.
 */
export function humanizeTag(tag: string): string {
  const t = tag.trim().replace(/_+/g, " ").toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

// ── The client-facing invoice ────────────────────────────────────────────────

export type InvoiceLine = {
  /** What the client reads. Never an internal field name, never a raw key. */
  label: string;
  /** Optional operator-typed detail, e.g. "25 bags at $6.00". Absent when not
   *  filled in — the invoice simply shows the line and the amount. */
  detail: string | null;
  amount: number;
};

/**
 * The lines a client sees, in the order they see them.
 *
 * ONE PLACE. The pay page, the receipt and the admin preview all read this, so
 * a line can never appear on one and be missing from another — and the sum is
 * guaranteed to equal `invoiceTotal`, which the build gate asserts rather than
 * leaves to trust.
 *
 * NOTHING INTERNAL LEAVES HERE. No `actualCost`, no margin, no supply unit
 * cost. Material lines were once omitted from the invoice entirely because they were
 * never billed — showing them would invent a charge the client never owed.
 */
export function invoiceLines(occ: PricedOccurrence & {
  laborDetail?: string | null;
  addons?: Array<{ price: number | null; tag?: string | null; customLabel?: string | null; detail?: string | null }> | null;
  invoiceCharges?: Array<{ cost: number; description?: string; detail?: string | null }> | null;
}, opts?: {
  laborLabel?: string;
  /** key → human label, from the SERVICE_TYPES setting. Without it an add-on
   *  picked from a preset prints its RAW KEY on the client's invoice —
   *  "HEDGE", "LEAF_CLEANUP". Every caller that can reach the DB must pass it. */
  serviceLabels?: Record<string, string>;
}): InvoiceLine[] {
  const lines: InvoiceLine[] = [];

  // Labor first, labelled by the SERVICE rather than "Labor" when the caller
  // supplies a name. An itemized "Labor $150" discloses the hourly rate; the
  // operator decides whether to do that via laborDetail.
  const labor = occ.price ?? 0;
  if (labor > 0) {
    lines.push({
      label: opts?.laborLabel?.trim() || "Service",
      detail: occ.laborDetail?.trim() || null,
      amount: round2(labor),
    });
  }

  for (const a of occ.addons ?? []) {
    const amount = a.price ?? 0;
    if (amount === 0) continue;
    // A typed custom label wins; otherwise resolve the preset's key through
    // the configured catalog. Falling back to humanizeTag covers a tag since
    // removed from the catalog — better a stale word than a raw key.
    const tag = a.tag?.trim() || "";
    const preset = tag ? (opts?.serviceLabels?.[tag] ?? humanizeTag(tag)) : "";
    lines.push({
      label: a.customLabel?.trim() || preset || "Additional service",
      detail: a.detail?.trim() || null,
      amount: round2(amount),
    });
  }

  for (const e of occ.invoiceCharges ?? []) {
    if (!e.cost) continue;
    lines.push({
      label: e.description?.trim() || "Materials",
      detail: e.detail?.trim() || null,
      amount: round2(e.cost),
    });
  }

  return lines;
}

/** The Prisma `select` every caller of invoiceTotal needs. Exported so a call
 *  site cannot quietly fetch too little and get a silently low invoice. */
export const PRICED_OCCURRENCE_SELECT = {
  price: true,
  addons: { select: { price: true } },
  invoiceCharges: { select: { cost: true } },
} as const;

/** Everything `invoiceLines` needs, on top of the totals. */
export const INVOICE_LINES_SELECT = {
  price: true,
  laborDetail: true,
  addons: { select: { price: true, tag: true, customLabel: true, detail: true } },
  invoiceCharges: { select: { cost: true, description: true, detail: true } },
} as const;
