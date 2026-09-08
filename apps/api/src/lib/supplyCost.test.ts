// FIFO cost layers — the arithmetic, proved against hand-computed scenarios.
//
// The wiring (which database rows become which events) is locked separately by
// the supply-cost build gate. This file only asks whether the replay is right.

import { describe, it, expect } from "vitest";
import {
  fifoCost,
  defaultClientUnitPrice,
  resolvePullUnitPrice,
  type SupplyCostEvent,
} from "./supplyCost";

const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
// Written per-unit for readability; the EVENT carries the receipt total,
// because that is what a purchase actually records.
const buy = (iso: string, quantity: number, unitCost: number): SupplyCostEvent =>
  ({ kind: "BUY", at: d(iso), quantity, totalCost: quantity * unitCost });
const buyTotal = (iso: string, quantity: number, totalCost: number): SupplyCostEvent =>
  ({ kind: "BUY", at: d(iso), quantity, totalCost });
const use = (iso: string, quantity: number): SupplyCostEvent =>
  ({ kind: "CONSUME", at: d(iso), quantity });
const adj = (iso: string, delta: number): SupplyCostEvent =>
  ({ kind: "ADJUST", at: d(iso), delta });

describe("fifoCost", () => {
  it("a supply never bought has no average — not zero", () => {
    // Zero would claim the stock was free. There is no honest number here.
    const r = fifoCost([]);
    expect(r.averageCost).toBeNull();
    expect(r.valueOnHand).toBeNull();
    expect(r.quantityOnHand).toBe(0);
  });

  it("one purchase: the average is that price", () => {
    const r = fifoCost([buy("2026-05-10", 21, 1.95)]);
    expect(r.averageCost).toBe(1.95);
    expect(r.quantityOnHand).toBe(21);
    expect(r.valueOnHand).toBe(40.95);
  });

  it("two purchases at different prices average by QUANTITY, not by price", () => {
    // 10 × $5 + 30 × $9 = $320 over 40 units = $8.00.
    // A naive mean of the two prices would say $7.00.
    const r = fifoCost([buy("2026-05-01", 10, 5), buy("2026-06-01", 30, 9)]);
    expect(r.averageCost).toBe(8);
    expect(r.valueOnHand).toBe(320);
  });

  it("THE POINT OF FIFO: consuming drops the OLDEST price off the average", () => {
    // 10 @ $5 then 10 @ $9. Use 10 and the cheap layer is gone entirely, so
    // what remains averages $9 — not the $7 blended figure it averaged before.
    const events = [buy("2026-05-01", 10, 5), buy("2026-06-01", 10, 9)];
    expect(fifoCost(events).averageCost).toBe(7);
    expect(fifoCost([...events, use("2026-07-01", 10)]).averageCost).toBe(9);
  });

  it("a consumption that straddles two layers drains the older one first", () => {
    // Use 15 of (10 @ $5, 10 @ $9): all 10 cheap units and 5 dear ones go.
    const r = fifoCost([buy("2026-05-01", 10, 5), buy("2026-06-01", 10, 9), use("2026-07-01", 15)]);
    expect(r.quantityOnHand).toBe(5);
    expect(r.averageCost).toBe(9);
    expect(r.layers).toEqual([{ quantity: 5, unitCost: 9 }]);
  });

  it("a partial draw leaves the remainder of the layer at its own price", () => {
    const r = fifoCost([buy("2026-05-01", 10, 5), use("2026-06-01", 4)]);
    expect(r.quantityOnHand).toBe(6);
    expect(r.averageCost).toBe(5);
  });

  it("a positive adjustment joins at the current average and does NOT move it", () => {
    // Found 5 more on the truck. They are a counting correction, not a buy.
    const before = fifoCost([buy("2026-05-01", 10, 5), buy("2026-06-01", 10, 9)]);
    const after = fifoCost([buy("2026-05-01", 10, 5), buy("2026-06-01", 10, 9), adj("2026-07-01", 5)]);
    expect(before.averageCost).toBe(7);
    expect(after.averageCost).toBe(7);
    expect(after.quantityOnHand).toBe(25);
    // …and the value on hand rises, because there really are more units.
    expect(after.valueOnHand).toBe(175);
  });

  it("a negative adjustment draws FIFO, exactly like consumption", () => {
    const r = fifoCost([buy("2026-05-01", 10, 5), buy("2026-06-01", 10, 9), adj("2026-07-01", -10)]);
    expect(r.quantityOnHand).toBe(10);
    expect(r.averageCost).toBe(9);
  });

  it("stock found before anything was ever bought is uncosted, not free", () => {
    const r = fifoCost([adj("2026-05-01", 5)]);
    expect(r.quantityOnHand).toBe(5);
    expect(r.uncostedQuantity).toBe(5);
    expect(r.averageCost).toBeNull();
  });

  it("uncosted units are excluded from the average rather than dragging it to zero", () => {
    // 5 found (no price) + 10 bought at $9. The average describes the units it
    // can speak for; counting the found ones at $0 would say $6.
    const r = fifoCost([adj("2026-05-01", 5), buy("2026-06-01", 10, 9)]);
    expect(r.averageCost).toBe(9);
    expect(r.uncostedQuantity).toBe(5);
    expect(r.quantityOnHand).toBe(15);
  });

  it("when consumption outruns the layers, the shortfall is reported", () => {
    const r = fifoCost([buy("2026-05-01", 5, 4), use("2026-06-01", 8)]);
    expect(r.quantityOnHand).toBe(0);
    expect(r.unbackedConsumption).toBe(3);
  });

  it("falls back to the last price paid when the layers run dry but stock remains", () => {
    // Bought 5 @ $4, used all 5, then found 2. Those 2 have no layer, but we
    // demonstrably bought this thing at $4 — a stale figure beats no figure.
    const r = fifoCost([buy("2026-05-01", 5, 4), use("2026-06-01", 5), adj("2026-07-01", 2)]);
    expect(r.quantityOnHand).toBe(2);
    expect(r.averageCost).toBe(4);
  });

  it("orders by EFFECTIVE DATE, so a back-dated receipt lands in history", () => {
    // A receipt entered late but dated before the consumption must be the
    // layer that consumption drew from. Passed in the order they were typed.
    const r = fifoCost([
      buy("2026-06-01", 10, 9),
      use("2026-05-15", 10),
      buy("2026-05-01", 10, 5), // entered last, dated first
    ]);
    // The May 1st cheap layer paid for the May 15th usage; June's is intact.
    expect(r.quantityOnHand).toBe(10);
    expect(r.averageCost).toBe(9);
    expect(r.unbackedConsumption).toBe(0);
  });

  it("a purchase and a same-day consumption settle in that order", () => {
    // Production's Timberline mulch: 26 bought and all 26 used on 2026-05-21.
    // Draining before the layer exists would report 26 unbacked units.
    const r = fifoCost([use("2026-05-21", 26), buy("2026-05-21", 26, 3.99)]);
    expect(r.unbackedConsumption).toBe(0);
    expect(r.quantityOnHand).toBe(0);
  });

  it("nothing on hand has no average — the average describes stock held", () => {
    // Not the last price paid. "Average price of the remaining inventory" is
    // a statement about units you have; with none, there is nothing to state.
    const r = fifoCost([buy("2026-05-01", 5, 3.99), use("2026-06-01", 5)]);
    expect(r.quantityOnHand).toBe(0);
    expect(r.averageCost).toBeNull();
    expect(r.valueOnHand).toBeNull();
  });

  it("REVERTING A PAYMENT RESTORES THE EXACT LAYER, with no unwind logic", () => {
    // Reverting clears `consumedAt`, so the CONSUME event simply stops
    // existing. Because the answer is replayed rather than stored, the layer
    // it drew comes back at its own price — this is why layers are derived.
    const base = [buy("2026-05-01", 10, 5), buy("2026-06-01", 10, 9)];
    const consumed = fifoCost([...base, use("2026-07-01", 10)]);
    const reverted = fifoCost(base);
    expect(consumed.averageCost).toBe(9);
    expect(reverted.averageCost).toBe(7);
    expect(reverted.layers).toEqual([
      { quantity: 10, unitCost: 5 },
      { quantity: 10, unitCost: 9 },
    ]);
  });

  it("a corrected purchase price changes the average with no migration", () => {
    // Editing the row is enough; there are no stored layers to rebuild.
    expect(fifoCost([buy("2026-05-01", 10, 5)]).averageCost).toBe(5);
    expect(fifoCost([buy("2026-05-01", 10, 6.5)]).averageCost).toBe(6.5);
  });

  it("value on hand is summed from the layers, not rebuilt from the average", () => {
    // 12 @ $6.50 + 6 @ $34.50 is exactly $285.00. The average rounds to
    // $15.83, and 18 × $15.83 is $284.94 — the rounding error multiplied by
    // the unit count. Caught against real seeded data, not in review.
    const r = fifoCost([buy("2026-05-01", 12, 6.5), buy("2026-06-01", 6, 34.5)]);
    expect(r.averageCost).toBe(15.83);
    expect(r.valueOnHand).toBe(285);
  });

  it("prices uncosted units at the average when reporting value", () => {
    // 5 found before anything was bought, then 10 @ $9. The costed units are
    // worth $90 exactly; the found ones are carried at the average rather
    // than silently valued at zero.
    const r = fifoCost([adj("2026-05-01", 5), buy("2026-06-01", 10, 9)]);
    expect(r.averageCost).toBe(9);
    expect(r.valueOnHand).toBe(135);
  });

  it("a layer is worth its RECEIPT TOTAL, not quantity x a rounded unit price", () => {
    // A 20 ft roll of bed edging at $45.99. Per-foot is $2.2995, which the
    // purchase row stores as $2.30 for display — and 20 x $2.30 is $46.00, a
    // penny conjured out of rounding. Finely divided units (feet off a roll,
    // ounces out of a jug) multiply the error hardest, which is why the event
    // carries the total and the division happens here, unrounded.
    const r = buyTotal("2026-05-01", 20, 45.99);
    expect(fifoCost([r]).valueOnHand).toBe(45.99);
    expect(fifoCost([r]).averageCost).toBe(2.3);
  });

  it("a partial draw off an odd-priced layer keeps the remainder exact", () => {
    // 8 ft used off that roll leaves 12 ft: 12 x $2.2995 = $27.594 -> $27.59.
    // Against the rounded $2.30 it would read $27.60.
    const r = fifoCost([buyTotal("2026-05-01", 20, 45.99), use("2026-06-01", 8)]);
    expect(r.quantityOnHand).toBe(12);
    expect(r.valueOnHand).toBe(27.59);
  });

  it("three boxes bought together stay exact across the whole layer", () => {
    // 3 x 20 ft at $45.99 = $137.97 for 60 ft. Per-foot is still $2.2995.
    const r = fifoCost([buyTotal("2026-05-01", 60, 137.97)]);
    expect(r.valueOnHand).toBe(137.97);
    expect(r.averageCost).toBe(2.3);
  });

  it("rounds only at the end, so thirds do not drift", () => {
    // 1 @ $10 + 2 @ $10.01 → 30.02 / 3 = 10.006666… → $10.01.
    const r = fifoCost([buy("2026-05-01", 1, 10), buy("2026-06-01", 2, 10.01)]);
    expect(r.averageCost).toBe(10.01);
  });

  it("does not mutate the caller's array", () => {
    const events = [buy("2026-06-01", 1, 2), buy("2026-05-01", 1, 3)];
    const copy = [...events];
    fifoCost(events);
    expect(events).toEqual(copy);
  });

  it("ignores zero and negative quantities rather than inverting them", () => {
    const r = fifoCost([buy("2026-05-01", 0, 5), use("2026-06-01", 0), adj("2026-07-01", 0)]);
    expect(r.quantityOnHand).toBe(0);
    expect(r.averageCost).toBeNull();
  });

  it("reproduces production: every supply replays to its real on-hand", () => {
    // Verified read-only against the production database on 2026-09-08 — the
    // event log alone lands on today's stock, so FIFO needs no opening balance.
    expect(fifoCost([buy("2026-05-10", 1, 53.5)]).quantityOnHand).toBe(1);
    expect(fifoCost([buy("2026-05-10", 21, 1.95)]).quantityOnHand).toBe(21);
    expect(
      fifoCost([buy("2026-05-21", 26, 3.99), use("2026-05-21", 26)]).quantityOnHand,
    ).toBe(0);
  });
});

describe("defaultClientUnitPrice", () => {
  it("a fixed price is used as typed, whatever the stock cost", () => {
    expect(defaultClientUnitPrice({ clientUnitPrice: 5 }, 4.15)).toBe(5);
    expect(defaultClientUnitPrice({ clientUnitPrice: 5, clientMarkupPercent: null }, 4.15)).toBe(5);
    // …and a fixed price does not need any purchase history behind it.
    expect(defaultClientUnitPrice({ clientUnitPrice: 5 }, null)).toBe(5);
  });

  it("a markup is applied to the AVERAGE COST, not to the fixed price", () => {
    // The fixed field is deliberately non-zero here: reading it instead of the
    // average is the obvious wiring mistake, and it would silently quote $22.
    expect(defaultClientUnitPrice({ clientUnitPrice: 20, clientMarkupPercent: 10 }, 4.15))
      .toBe(4.57);
  });

  it("the default MOVES as the average moves — that is the point", () => {
    const rule = { clientUnitPrice: 0, clientMarkupPercent: 25 };
    expect(defaultClientUnitPrice(rule, 4.0)).toBe(5);
    expect(defaultClientUnitPrice(rule, 4.6)).toBe(5.75);
  });

  it("a markup with no purchase history has NO default, rather than a wrong one", () => {
    // Falling back to the fixed price would quote a number the operator
    // explicitly stopped using; falling back to zero would offer the stock
    // free. Null makes the pull dialog ask.
    expect(defaultClientUnitPrice({ clientUnitPrice: 9.99, clientMarkupPercent: 30 }, null))
      .toBeNull();
  });

  it("zero percent is a real markup, not 'no markup configured'", () => {
    // `0` and `null` are different answers: bill at cost, versus use the fixed
    // price. A truthiness check here would silently swap one for the other.
    expect(defaultClientUnitPrice({ clientUnitPrice: 20, clientMarkupPercent: 0 }, 4.15))
      .toBe(4.15);
  });

  it("rounds to cents", () => {
    expect(defaultClientUnitPrice({ clientUnitPrice: 0, clientMarkupPercent: 33 }, 1.95))
      .toBe(2.59);
  });
});

describe("resolvePullUnitPrice", () => {
  const fixed = { clientUnitPrice: 5 };
  const markup = { clientUnitPrice: 5, clientMarkupPercent: 20 };

  it("a typed price wins over every default — this client, this job", () => {
    expect(resolvePullUnitPrice(9, fixed, 4)).toEqual({ ok: true, unitPrice: 9 });
    expect(resolvePullUnitPrice(9, markup, 4)).toEqual({ ok: true, unitPrice: 9 });
  });

  it("a typed ZERO is a real price, not a missing one", () => {
    // Billing a client nothing for materials is a decision an operator is
    // allowed to make; `|| default` would silently overwrite it.
    expect(resolvePullUnitPrice(0, markup, 4)).toEqual({ ok: true, unitPrice: 0 });
  });

  it("falls back to the fixed price when nothing is typed", () => {
    expect(resolvePullUnitPrice(null, fixed, 4)).toEqual({ ok: true, unitPrice: 5 });
    expect(resolvePullUnitPrice(undefined, fixed, null)).toEqual({ ok: true, unitPrice: 5 });
  });

  it("falls back to the MARKUP, not the stale fixed field", () => {
    // 4.00 + 20% = 4.80. Reading clientUnitPrice would quote 5.00 — the
    // number the operator explicitly stopped using.
    expect(resolvePullUnitPrice(null, markup, 4)).toEqual({ ok: true, unitPrice: 4.8 });
  });

  it("refuses rather than guessing when a markup has no cost behind it", () => {
    expect(resolvePullUnitPrice(null, markup, null)).toEqual({
      ok: false,
      reason: "NO_DEFAULT_PRICE",
    });
  });
});
