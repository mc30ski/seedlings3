-- Reconciliation hint on JobOccurrence — the payment method the
-- client last TAPPED on the public /pay/[token] page. Not a payment
-- claim; helps the operator know where to look when tracking down
-- an actual payment. See the JobOccurrence.paymentIntentMethod
-- docstring for semantics.
--
-- Nullable, no backfill — every existing occurrence stays null
-- (unknown intent), which is the correct initial state.

ALTER TABLE "JobOccurrence"
  ADD COLUMN "paymentIntentMethod" TEXT,
  ADD COLUMN "paymentIntentAt" TIMESTAMP(3);
