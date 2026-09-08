-- ONE PRICING MODEL. The LEGACY/ITEMIZED split is removed entirely.
--
-- The split existed because historical visits never billed their materials:
-- a $100 mow with $60 of mulch invoiced $100 and paid the crew out of $40.
-- Reproducing that needed a rule that travelled with the row, so every money
-- calculation branched — nineteen sites across eight files, and the same
-- "forgot to branch" bug shipped in six of them.
--
-- It was never necessary. Both facts are reproducible by rewriting the DATA:
--
--     LEGACY   : invoice = base,             pool = base − charges
--     ITEMIZED : invoice = price + charges,  pool = price
--
-- Set price = base − charges and the itemized rule reproduces BOTH exactly.
-- Verified against production first: 516 occurrences, 9 carry charges, and
-- none has charges exceeding its price — so every row converts without loss.
--
-- WHAT CHANGES FOR A HUMAN: those 9 historical invoices now itemise. A job
-- billed as one "$462.50" line reads "$183.23 + $279.27". Same total, same
-- payout, same deduction — a different-looking document if a client reopens a
-- months-old link.
--
-- WHAT DOES NOT CHANGE: invoice totals, crew pools, recorded payments, splits,
-- and every BusinessExpense. The Ledger is untouched by this migration.

-- Refuse rather than corrupt. If any row would end up with a negative price
-- the assumption behind this migration is wrong for this database, and a
-- half-applied rewrite of financial history is far worse than a failed deploy.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad
  FROM (
    SELECT COALESCE(o."price", 0)
             + COALESCE((SELECT sum(a."price") FROM "OccurrenceAddon" a WHERE a."occurrenceId" = o."id"), 0) AS base,
           COALESCE((SELECT sum(e."cost") FROM "Expense" e WHERE e."occurrenceId" = o."id"), 0) AS charges
    FROM "JobOccurrence" o
    WHERE o."pricingModel" = 'LEGACY'
  ) t
  WHERE t.charges > t.base;

  IF bad > 0 THEN
    RAISE EXCEPTION
      'Refusing to unify pricing: % legacy occurrence(s) carry charges exceeding their price, so the converted price would be negative. Resolve those rows first.', bad;
  END IF;
END $$;

-- The rewrite. Only LEGACY rows: an ITEMIZED row already prices this way.
-- Add-ons are untouched — they are WORK and belong to the pool under both
-- rules, so only the labor figure absorbs the shift.
UPDATE "JobOccurrence" o
   SET "price" = ROUND((COALESCE(o."price", 0)
        - COALESCE((SELECT sum(e."cost") FROM "Expense" e WHERE e."occurrenceId" = o."id"), 0))::numeric, 2)
 WHERE o."pricingModel" = 'LEGACY'
   AND EXISTS (SELECT 1 FROM "Expense" e WHERE e."occurrenceId" = o."id");

-- The concept is gone, so the column and its enum go with it. Nothing may be
-- left that a future calculation could branch on.
ALTER TABLE "JobOccurrence" DROP COLUMN "pricingModel";
DROP TYPE "JobPricingModel";
