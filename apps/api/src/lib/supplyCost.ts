// ─────────────────────────────────────────────────────────────────────────────
// FIFO cost layers for a supply.
//
// WHAT THIS REPLACES. `Supply.businessCost` was a single stored number that
// `recordPurchase` silently overwrote with the latest receipt's per-unit price.
// It was labelled "what you pay", which reads as a policy the operator sets,
// while behaving as "what you happened to pay most recently" — a figure that
// changed under them whenever anyone recorded a purchase. It described no real
// quantity: not what the stock on the shelf cost, not what the next unit will
// cost.
//
// WHAT THIS IS INSTEAD. Every purchase is a LAYER of units at a known price.
// Consumption draws from the OLDEST layer first, so as stock is used the price
// of the oldest units drops out of the average. What remains is the weighted
// average cost of the units actually on hand — a fact about inventory held,
// derived rather than typed.
//
// DERIVED, NEVER STORED. This replays the event log on every read instead of
// maintaining layer rows, and that is the point:
//
//   • Reverting a payment un-consumes a hold (`consumedAt` is cleared). With
//     stored layers we would have to record which layers each consumption drew
//     from and unwind them exactly. Replayed, the layer simply comes back,
//     because the answer is recomputed from what is true now.
//   • Correcting or deleting a past purchase silently corrupts every stored
//     layer after it. Replayed, it just comes out right.
//   • A stored column that is supposed to be derived is the drift trap this
//     codebase has been bitten by repeatedly.
//
// The volume is a few dozen rows per supply. There is no performance argument
// for caching this, and caching it would cost correctness.
//
// NOT A TAX FIGURE. Nothing here reaches the invoice, a payout, the P&L or an
// export. What was actually spent is a BusinessExpense in the Ledger, which is
// what gets reconciled against the accounting software. This is the
// stock-tracking layer above it — see docs/features/job-materials.md.
// ─────────────────────────────────────────────────────────────────────────────

/** One thing that happened to a supply's stock, with the date it took effect. */
export type SupplyCostEvent =
  /**
   * A purchase: `quantity` units for `totalCost` all in.
   *
   * THE RECEIPT TOTAL IS THE INPUT, never a per-unit price. That is how
   * `recordPurchase` takes it — the figure on the receipt includes tax and any
   * discount and is the only one that reconciles to a bank line — and it is
   * what keeps a layer's value exact. `SupplyPurchase.unitCost` is a rounded
   * DISPLAY derivation of this and must not be fed back in: a 20 ft roll at
   * $45.99 stores $2.30/ft, and 20 x $2.30 conjures $46.00 out of rounding.
   */
  | { kind: "BUY"; at: Date; quantity: number; totalCost: number }
  /** Stock leaving the shelf for a job (a hold reaching CONSUMED). */
  | { kind: "CONSUME"; at: Date; quantity: number }
  /** A count correction. `delta` may be either sign. */
  | { kind: "ADJUST"; at: Date; delta: number };

export type SupplyCostLayer = {
  quantity: number;
  /**
   * Exact per-unit cost, UNROUNDED — `totalCost / quantity`. Rounding lives at
   * the very end, on the figures actually displayed; rounding here multiplies
   * the error by the unit count, and finely divided units (feet off a roll,
   * ounces out of a jug) multiply it hardest.
   *
   * null = these units entered without a price behind them.
   */
  unitCost: number | null;
};

export type SupplyCostResult = {
  /**
   * Weighted average cost of the units still on hand.
   *
   * null when the supply has never been bought — there is no honest number to
   * show, and 0 would claim the stock was free.
   */
  averageCost: number | null;
  /** `averageCost × quantityOnHand`, or null when there is no average. */
  valueOnHand: number | null;
  /** Units the replay says remain. Should agree with `Supply.onHand`. */
  quantityOnHand: number;
  /** On-hand units with no cost layer behind them. */
  uncostedQuantity: number;
  /**
   * Units consumed that no layer could pay for — consumption outran the
   * recorded purchases. Diagnostic: it means stock left the shelf that was
   * never entered as a buy.
   */
  unbackedConsumption: number;
  /** What is left, oldest first. Exposed for the history view and for tests. */
  layers: SupplyCostLayer[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// Additions settle before removals when they share a timestamp. Recording a
// receipt and pulling it straight onto a job on the same day is ordinary, and
// draining a layer that the same instant created would report the units as
// unbacked. `date` on a purchase is a user-entered day, so same-day ties are
// the common case, not an edge one.
const RANK: Record<SupplyCostEvent["kind"], number> = { BUY: 0, ADJUST: 1, CONSUME: 2 };

/**
 * Replay a supply's stock events and report what the remaining units cost.
 *
 * Events may arrive in any order; they are sorted by their effective date. A
 * back-dated purchase therefore takes its place in history rather than being
 * appended to it, which is what makes correcting a receipt's date behave the
 * way an operator expects.
 */
export function fifoCost(events: SupplyCostEvent[]): SupplyCostResult {
  const ordered = [...events].sort((a, b) => {
    const d = a.at.getTime() - b.at.getTime();
    return d !== 0 ? d : RANK[a.kind] - RANK[b.kind];
  });

  const layers: SupplyCostLayer[] = [];
  let unbackedConsumption = 0;
  /** Most recent purchase price, for stock whose own layers have run out. */
  let lastKnownUnitCost: number | null = null;

  /** Weighted average of the costed units currently in `layers`. */
  const currentAverage = (): number | null => {
    let qty = 0;
    let value = 0;
    for (const l of layers) {
      if (l.unitCost == null) continue;
      qty += l.quantity;
      value += l.quantity * l.unitCost;
    }
    return qty > 0 ? value / qty : null;
  };

  /** Remove `n` units, oldest layer first. */
  const draw = (n: number) => {
    let remaining = n;
    while (remaining > 0 && layers.length > 0) {
      const head = layers[0];
      if (head.quantity > remaining) {
        head.quantity -= remaining;
        remaining = 0;
      } else {
        remaining -= head.quantity;
        layers.shift();
      }
    }
    // Nothing left to draw from: stock left the shelf that was never bought.
    if (remaining > 0) unbackedConsumption += remaining;
  };

  for (const e of ordered) {
    if (e.kind === "BUY") {
      if (e.quantity <= 0) continue;
      const unitCost = e.totalCost / e.quantity;
      layers.push({ quantity: e.quantity, unitCost });
      lastKnownUnitCost = unitCost;
    } else if (e.kind === "CONSUME") {
      if (e.quantity <= 0) continue;
      draw(e.quantity);
    } else {
      if (e.delta === 0) continue;
      if (e.delta > 0) {
        // A COUNT CORRECTION IS NOT AN ACQUISITION. Units found on the truck
        // join at what the remaining stock already averages, so the average
        // does not move — pricing them at zero would report inventory as
        // cheaper than it was because somebody miscounted.
        layers.push({ quantity: e.delta, unitCost: currentAverage() });
      } else {
        draw(-e.delta);
      }
    }
  }

  let costedQty = 0;
  let costedValue = 0;
  let uncostedQuantity = 0;
  for (const l of layers) {
    if (l.unitCost == null) {
      uncostedQuantity += l.quantity;
      continue;
    }
    costedQty += l.quantity;
    costedValue += l.quantity * l.unitCost;
  }
  const quantityOnHand = costedQty + uncostedQuantity;

  // Units remain but every layer behind them is uncosted. Fall back to the
  // last price actually paid — a stale figure beats no figure for stock we
  // demonstrably bought at some point. Never bought at all stays null.
  const averageCost =
    costedQty > 0
      ? round2(costedValue / costedQty)
      : quantityOnHand > 0 && lastKnownUnitCost != null
        ? round2(lastKnownUnitCost)
        : null;

  // VALUE IS SUMMED FROM THE LAYERS, NOT REBUILT FROM THE AVERAGE. Rounding
  // the average to cents and then multiplying it back up multiplies the
  // rounding error by the unit count: 12 @ $6.50 + 6 @ $34.50 is exactly
  // $285.00, but the average rounds to $15.83 and 18 × $15.83 reports
  // $284.94. The average is for display; the value is arithmetic.
  const valueOnHand =
    averageCost == null
      ? null
      : round2(costedValue + uncostedQuantity * averageCost);

  return {
    averageCost,
    valueOnHand,
    quantityOnHand,
    uncostedQuantity,
    unbackedConsumption,
    layers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalog's DEFAULT charge to a client.
//
// Two ways to express it, and a supply uses one or the other:
//
//   • A FIXED amount        — `clientUnitPrice`, typed once.
//   • A MARKUP on cost      — `clientMarkupPercent`, applied to the weighted
//                             average of the stock actually on hand, so the
//                             default follows what the item now costs instead
//                             of going stale the next time prices move.
//
// WHICH MODE IS IN USE IS NOT A THIRD FIELD. `clientMarkupPercent` is null for
// a fixed price and set for a markup — one value, one meaning, and no mode
// flag that can disagree with the number beside it.
//
// EITHER WAY THIS IS ONLY A DEFAULT. What a client actually pays is chosen
// when the supply goes onto a job, snapshotted onto the hold, and never
// re-rated afterwards — so a markup that moves tomorrow cannot change what
// was billed today.
// ─────────────────────────────────────────────────────────────────────────────

export type SupplyPricingRule = {
  /** The typed per-unit price. Used when `clientMarkupPercent` is null. */
  clientUnitPrice: number;
  /** Percent ON TOP of average cost. Null = use the fixed price instead. */
  clientMarkupPercent?: number | null;
};

/**
 * The default per-unit charge to suggest for this supply, or null when a
 * markup is configured but there is no cost to mark up yet.
 *
 * A markup with no purchase history has no honest answer: falling back to the
 * fixed price would quote a number the operator explicitly stopped using, and
 * falling back to zero would offer the stock for free. Null makes the pull
 * dialog ask, which is the correct behaviour for "we have never bought this".
 */
export function defaultClientUnitPrice(
  rule: SupplyPricingRule,
  averageCost: number | null,
): number | null {
  const pct = rule.clientMarkupPercent;
  if (pct == null) return rule.clientUnitPrice;
  if (averageCost == null) return null;
  return Math.round(averageCost * (1 + pct / 100) * 100) / 100;
}

/**
 * What a pull should charge per unit: the operator's typed price if there is
 * one, otherwise the catalog's default.
 *
 * LIFTED OUT OF `addHold` SO IT CAN BE TESTED. Inside a transaction this
 * decision was only reachable through a database, so the coverage on it was a
 * source scan asserting the right function got called — which a mutation that
 * kept the call and ignored its result walked straight past. A pure function
 * takes the rule out of the untestable region entirely.
 */
export type PullPrice =
  | { ok: true; unitPrice: number }
  /** A markup with nothing to mark up. The caller must ask for a price. */
  | { ok: false; reason: "NO_DEFAULT_PRICE" };

export function resolvePullUnitPrice(
  typed: number | null | undefined,
  rule: SupplyPricingRule,
  averageCost: number | null,
): PullPrice {
  // A typed price always wins — it is this client, on this job.
  if (typed != null) return { ok: true, unitPrice: typed };
  const fallback = defaultClientUnitPrice(rule, averageCost);
  if (fallback == null) return { ok: false, reason: "NO_DEFAULT_PRICE" };
  return { ok: true, unitPrice: fallback };
}
