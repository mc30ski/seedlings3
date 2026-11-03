-- Timing constraints, as a KIND of instruction rather than a new table.
--
-- The split is WHEN the information is needed. A NOTE is read on site; a
-- TIMING is read before setting off ("before 11", "not 1–3, baby
-- napping"). A crew that finds out on arrival has already wasted the
-- drive, so TIMING is banded across the top of the job card at every
-- density while notes stay in the body.
--
-- Reusing OccurrenceInstruction rather than adding a field to Job gets
-- the scope machinery for free: a standing constraint is EVERY_VISIT, a
-- one-off is THIS_VISIT, and the existing carry-forward already moves
-- them onto new occurrences. A flat column on Job could only ever be
-- permanent.
--
-- Defaulted to NOTE so every existing row keeps its meaning untouched.
CREATE TYPE "InstructionKind" AS ENUM ('NOTE', 'TIMING');
ALTER TABLE "OccurrenceInstruction"
  ADD COLUMN "kind" "InstructionKind" NOT NULL DEFAULT 'NOTE';

-- AT MOST ONE TIMING PER SCOPE PER VISIT, enforced in the database and
-- not only in the service. A job carries one standing timing and one for
-- this visit; a second of the same scope is a replacement, which the UI
-- asks about before sending. Without this, two concurrent edits could
-- both land and the card would have to decide which to believe.
CREATE UNIQUE INDEX "OccurrenceInstruction_one_timing_per_scope"
  ON "OccurrenceInstruction" ("occurrenceId", "scope")
  WHERE "kind" = 'TIMING';
