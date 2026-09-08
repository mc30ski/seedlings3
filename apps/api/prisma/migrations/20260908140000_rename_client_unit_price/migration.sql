-- `jobPayoutCost` is what the CLIENT is charged per unit, not anything to do
-- with a worker's payout.
--
-- The name is a leftover from the model where materials came out of the crew's
-- pool. They never do — the client is billed for them on top of the labor
-- price — so every reader of this column was told the opposite of what it
-- means. It leaked into the UI as "Job payout cost (per unit)", where an
-- operator setting a supply's price was told they were setting worker pay.
--
-- RENAME, not add-and-copy: the data is unchanged and every value keeps its
-- meaning. Postgres rewrites no rows.
ALTER TABLE "Supply"     RENAME COLUMN "jobPayoutCost" TO "clientUnitPrice";
ALTER TABLE "SupplyHold" RENAME COLUMN "jobPayoutCost" TO "clientUnitPrice";
