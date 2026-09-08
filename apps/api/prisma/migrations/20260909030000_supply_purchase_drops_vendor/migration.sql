-- A vendor is a Ledger fact, not a stock fact.
--
-- `SupplyPurchase.vendor` duplicated `BusinessExpense.vendor`, so the same
-- question had two answers — and in production they had already diverged: one
-- receipt read "Lowes" on the purchase and "Lowe's Hardware" on the very
-- ledger row that purchase pointed at. Neither was authoritative, and only the
-- ledger row is reconciled against the accounting software.
--
-- UNLIKE THE INVOICE NUMBER, THIS COLUMN HAS DATA. All six production
-- purchases carry a vendor, so it is preserved before being dropped rather
-- than discarded:
--
--   1. Where a purchase points at a ledger row whose OWN vendor is blank, the
--      purchase's vendor is copied up. That is a strict gain: the ledger row
--      ends up knowing something it did not, and the fact survives on the side
--      that owns it.
--   2. Where the ledger row already names a vendor, it wins untouched — it is
--      the reconciled record, and overwriting it with a second-hand copy is
--      how "Lowe's Hardware" would have become "Lowes".
--
-- WHAT IS GENUINELY LOST: a purchase with NO ledger link has nowhere to put
-- its vendor. Production has one such row today ("NoFloat 2-cu ft Cypress
-- Blend Mulch", vendor "Lowes"). It is recorded here because a migration that
-- destroys something should say what.
UPDATE "BusinessExpense" b
   SET "vendor" = p."vendor"
  FROM "SupplyPurchase" p
 WHERE p."businessExpenseId" = b."id"
   AND b."vendor" IS NULL
   AND p."vendor" IS NOT NULL;

ALTER TABLE "SupplyPurchase" DROP COLUMN "vendor";
