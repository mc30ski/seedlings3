-- Gusto emits "Paycheck Tips" only once a payroll period actually carries
-- tips, so the column did not exist in any earlier export. The importer maps
-- by header NAME (not position), so its arrival corrupted nothing — it was
-- simply unrecognised, and unrecognised columns were silently dropped.
ALTER TABLE "PayrollEntry" ADD COLUMN "paycheckTips" DOUBLE PRECISION;

-- BACKFILL FROM raw. Every entry keeps the original CSV row verbatim in
-- `raw`, so the already-imported period does not have to be re-uploaded.
--
-- "" IS NOT ZERO. One employee on the first tipped period has an empty
-- Paycheck Tips cell while the others carry a figure; collapsing that to 0
-- would assert Gusto computed a zero tip for them, which it did not. Only
-- non-empty cells are backfilled — the rest stay NULL, which is what "this
-- did not apply" means everywhere else in this table.
UPDATE "PayrollEntry"
SET "paycheckTips" = NULLIF(btrim("raw" ->> 'Paycheck Tips'), '')::double precision
WHERE "raw" ? 'Paycheck Tips'
  AND NULLIF(btrim("raw" ->> 'Paycheck Tips'), '') IS NOT NULL;
