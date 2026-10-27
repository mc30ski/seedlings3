-- Rename three columns named after deleted roles.
--
-- WRITTEN BY HAND, as renames. `prisma migrate dev` cannot tell a rename
-- from a delete-plus-add and would have emitted DROP + ADD on each, losing
-- every client's internal tags and un-restricting every restricted document
-- and timeline event.
--
--   Client.adminTags          -> internalTags
--     Internal context about a client. Stripped from client-facing payloads
--     by observerRedaction; the old name implied a role owned it.
--
--   CompanyDocument.adminHidden -> restricted
--   TimelineEvent.adminHidden   -> restricted
--     Rows served only to callers holding `documents.manage` /
--     `timeline.manage` (routes/documents.ts, routes/timeline.ts). "Hidden
--     from admins" was backwards as well as role-named: it is hidden from
--     everyone WITHOUT that entitlement.
ALTER TABLE "Client" RENAME COLUMN "adminTags" TO "internalTags";
ALTER TABLE "CompanyDocument" RENAME COLUMN "adminHidden" TO "restricted";
ALTER TABLE "TimelineEvent" RENAME COLUMN "adminHidden" TO "restricted";
