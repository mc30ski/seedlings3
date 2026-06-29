-- Fix the sign-in dedupe key. The prior column `lastSessionIat`
-- stored the JWT `iat` claim, which Clerk rotates every ~60s on
-- silent token refresh — that broke dedupe and produced a spurious
-- SIGN_IN audit entry per refresh. Switch to Clerk's `sid` claim,
-- which is stable for the lifetime of an actual browser session.
ALTER TABLE "User"
  ADD COLUMN "lastSessionId" TEXT;

ALTER TABLE "User"
  DROP COLUMN "lastSessionIat";

-- Every existing SIGN_IN audit row was written under the broken
-- dedupe and represents noise (one per token refresh, not one per
-- session). Nuke them so the activity feed starts clean — real
-- sign-ins will populate going forward.
DELETE FROM "AuditEvent" WHERE "verb" = 'SIGN_IN';

-- Also clear the now-meaningless lastSignInAt mirror; the next real
-- sign-in will refresh it.
UPDATE "User" SET "lastSignInAt" = NULL;
