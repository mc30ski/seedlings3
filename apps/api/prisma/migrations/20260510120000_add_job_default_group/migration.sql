-- Allow a Job to declare a default Group (crew). When set, occurrence
-- generation materializes the group's roster onto every new occurrence
-- instead of using the JobAssigneeDefault rows. Either mode is valid;
-- both at once is rejected in app code.

ALTER TABLE "Job" ADD COLUMN "defaultGroupId" TEXT;
CREATE INDEX "Job_defaultGroupId_idx" ON "Job"("defaultGroupId");
ALTER TABLE "Job" ADD CONSTRAINT "Job_defaultGroupId_fkey"
    FOREIGN KEY ("defaultGroupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
