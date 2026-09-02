// ─────────────────────────────────────────────────────────────────────────────
// @repo/money — the pure money math, shared by the API and the web app.
//
// Everything in this package is PURE: no prisma, no network, no clock, no
// settings reads. Callers supply the rates and the data. That is what makes it
// safe for the same code to run inside a payment approval on the server and
// inside a slider drag in the browser.
//
// It exists because of a specific failure mode. A forecasting tool that
// reimplements payout math drifts from production the first time a rate rule
// changes — silently, while still looking authoritative. So the simulator is
// not allowed its own copy: it calls the same computeBreakdown() that writes
// real PaymentSplit rows.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./payoutMath";
export * from "./forecastModel";
