-- Drop ExportRun table + the ExportKind enum.
--
-- Operator-decided cleanup: the new Money → Preview tab does not save
-- downloads to history or maintain re-download bytes. The QB/Gusto
-- bundle + per-CSV endpoints are also being removed in favor of two
-- simpler CSVs (Expenses + Workers) for visual reconciliation against
-- QuickBooks. ExportRun has no reads remaining after this change.

DROP TABLE IF EXISTS "ExportRun";
DROP TYPE IF EXISTS "ExportKind";
