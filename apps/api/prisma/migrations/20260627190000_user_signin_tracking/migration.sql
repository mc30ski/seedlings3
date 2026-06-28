-- Sign-in tracking for the Super → Users activity section.
-- `lastSignInAt` mirrors the most-recent WRITE of the SIGN_IN audit
-- event for fast card rendering; `lastSessionIat` is the dedupe key
-- (claims.iat in seconds) so a single session's many requests record
-- ONE sign-in event, not one per request.
ALTER TABLE "User"
  ADD COLUMN "lastSignInAt"   TIMESTAMP(3),
  ADD COLUMN "lastSessionIat" INTEGER;

-- New audit verb for the sign-in event itself. Written from the auth
-- plugin when it observes a JWT with a previously-unseen `iat` for
-- this user. Readable via the per-user activity endpoint that powers
-- the Super → Users "Sign-ins & activity" section.
ALTER TYPE "AuditVerb" ADD VALUE IF NOT EXISTS 'SIGN_IN';
