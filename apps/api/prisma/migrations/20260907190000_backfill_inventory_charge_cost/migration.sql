-- Inventory-backed charges never recorded what the units cost us.
--
-- Pulling stock onto a job creates a paired InvoiceCharge at
-- quantity x Supply.jobPayoutCost (what the CLIENT pays) but left
-- `actualCost` NULL — even though this is the one case where the cost is known
-- exactly, from the supply catalog. Job profit then reported "no cost recorded
-- on N charges" and showed an UPPER BOUND on jobs whose materials came off our
-- own shelf. The service now sets it on create and re-derives it whenever the
-- held quantity changes; this fills in the rows that predate that.
--
-- APPROXIMATION, DELIBERATELY. SupplyHold snapshots `jobPayoutCost` (the
-- charge) but never snapshotted the cost, so the only figure available for a
-- historical row is the catalog's CURRENT businessCost — itself a last-paid
-- heuristic that recordPurchase overwrites. For a supply whose price has moved
-- since, this is close rather than exact.
--
-- Chosen over leaving NULL because NULL makes every one of these jobs report
-- an unknown margin, which is worse than a good estimate for stock we bought
-- ourselves. Only rows with no value at all are touched — anything already
-- recorded is left alone.
UPDATE "Expense" e
   SET "actualCost" = ROUND((h."quantity" * s."businessCost")::numeric, 2)
  FROM "SupplyHold" h
  JOIN "Supply" s ON s."id" = h."supplyId"
 WHERE h."expenseId" = e."id"
   AND e."actualCost" IS NULL
   AND h."status" <> 'RELEASED';
