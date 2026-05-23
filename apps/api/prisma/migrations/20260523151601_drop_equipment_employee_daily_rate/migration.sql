-- DropColumn
-- The employee equipment-usage charge concept was removed; only contractors
-- are charged. Employee and trainee rates are gone — the column previously
-- stored a per-employee daily rental rate that no longer applies.
ALTER TABLE "Equipment" DROP COLUMN "employeeDailyRate";
