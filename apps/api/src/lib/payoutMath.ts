// Moved to packages/money so the web app's forecasting tool can call the
// exact same functions that write real PaymentSplit rows. Re-exported from
// this path because services/payments.ts and the payments build gate import
// it from here, and a shared-package move should not churn callers.
export * from "@repo/money";
