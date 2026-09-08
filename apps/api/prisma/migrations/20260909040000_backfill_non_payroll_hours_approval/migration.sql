-- Stamp hours approval on completed NON-PAYROLL occurrences.
--
-- `evaluateHoursApproval` (services/jobs.ts) auto-approves any workflow that
-- is not STANDARD or ONE_OFF the moment it completes, precisely so estimates,
-- tasks, reminders and events never sit in the review queue:
--
--     if (workflow !== "STANDARD" && workflow !== "ONE_OFF") {
--       return { hoursApprovedAt: completedAt, hoursApprovedById: currentUserId };
--     }
--
-- Rows completed BEFORE that rule existed were never stamped. Production has
-- 19 of them (17 ESTIMATE, 2 EVENT, completed June–August 2026) sitting in a
-- state the current code cannot produce.
--
-- HARMLESS TODAY, WHICH IS THE PROBLEM. Every consumer filters by workflow, so
-- nothing surfaces them — the alert badge correctly reads 0. They are a trap
-- for the next query written without that filter, which is exactly the mistake
-- that turned up their existence: a count of "completed and unapproved" that
-- omitted the workflow clause reported 19 jobs awaiting approval when the real
-- answer was none.
--
-- `hoursApprovedById` IS DELIBERATELY LEFT NULL. No person approved these; the
-- rule did. The column is nullable, nothing reads it, and inventing an
-- approver would put a name against a decision that human never made.
--
-- STANDARD and ONE_OFF are untouched. Those are the workflows whose hours
-- reach payroll, and an unapproved one there is a real review item — the Gusto
-- exports filter on `hoursApprovedAt IS NOT NULL` to keep it out of a
-- paycheck until someone looks.
UPDATE "JobOccurrence"
   SET "hoursApprovedAt" = "completedAt"
 WHERE "completedAt" IS NOT NULL
   AND "hoursApprovedAt" IS NULL
   AND "workflow" NOT IN ('STANDARD', 'ONE_OFF');
