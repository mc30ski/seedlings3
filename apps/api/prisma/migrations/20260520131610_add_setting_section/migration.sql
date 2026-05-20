-- Presentational grouping for the Settings tab. Nullable — historical rows
-- and any setting created without it fall into the UI's "Other" group.
-- Section titles/descriptions/order are a web-side code constant; this
-- column only carries each setting's section key.
ALTER TABLE "Setting" ADD COLUMN "section" TEXT;
