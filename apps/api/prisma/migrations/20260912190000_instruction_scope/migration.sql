-- Instruction scope: a three-way replacement for the `repeats` boolean.
--
-- `repeats` could say "every visit" or "this visit" and nothing else. The case
-- it could not express: a client asking, as a visit ends, for something to be
-- done NEXT time — when the next visit does not exist yet because the job is
-- not rescheduled until payment clears.
--
-- Backfill is exact and lossless: true -> EVERY_VISIT, false -> THIS_VISIT.
-- Nothing becomes NEXT_VISIT_ONLY retroactively; that state only ever arrives
-- from an operator choosing it.
CREATE TYPE "InstructionScope" AS ENUM ('THIS_VISIT', 'EVERY_VISIT', 'NEXT_VISIT_ONLY');

ALTER TABLE "OccurrenceInstruction"
  ADD COLUMN "scope" "InstructionScope" NOT NULL DEFAULT 'EVERY_VISIT',
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "deliveredToOccurrenceId" TEXT;

UPDATE "OccurrenceInstruction"
  SET "scope" = CASE WHEN "repeats" THEN 'EVERY_VISIT'::"InstructionScope"
                     ELSE 'THIS_VISIT'::"InstructionScope" END;

ALTER TABLE "OccurrenceInstruction" DROP COLUMN "repeats";

CREATE INDEX "OccurrenceInstruction_scope_deliveredAt_idx"
  ON "OccurrenceInstruction"("scope", "deliveredAt");
