-- WorkerType: TRAINEE out, UNPAID in.
--
-- WHY TRAINEE GOES
-- It carried no payroll meaning. Four money call sites read
-- `EMPLOYEE || TRAINEE` identically — same W-2 treatment, same write-off
-- make-whole, same absence of a contractor fee. Being a trainee was never
-- about how someone is paid; it was about not yet being trusted to close out
-- a visit. That is a permission, and it now lives in one: a trainee is an
-- EMPLOYEE who has not been granted field clearance. Promoting them grants a
-- role instead of changing their tax status, which was always the wrong
-- lever to pull.
--
-- WHY UNPAID ARRIVES
-- A real answer to "how is this person paid": they are not. A family member
-- with genuine access to see what is happening, and no place in payroll.
--
-- Postgres cannot remove an enum value, so the type is rebuilt. Existing
-- trainees become EMPLOYEE — which is what they already were for every
-- money purpose, so no payroll figure changes.

-- 1. Record who was a trainee BEFORE the information is destroyed. These are
--    the people who must NOT be granted field clearance when the starter
--    script assigns roles; without this the distinction is simply lost.
INSERT INTO "AuditEvent" ("id", "scope", "verb", "actorUserId", "metadata", "createdAt")
SELECT
  gen_random_uuid()::text, 'ROLE'::"AuditScope", 'UPDATED'::"AuditVerb", NULL,
  json_build_object(
    'migration', '20261012011000_workertype_drop_trainee_add_unpaid',
    'note', 'Users who were TRAINEE before the type was removed. They become EMPLOYEE for payroll (which they already were) and must NOT receive field clearance.',
    'formerTrainees', COALESCE((
      SELECT json_agg(json_build_object('userId', u."id", 'displayName', u."displayName"))
      FROM "User" u WHERE u."workerType" = 'TRAINEE'
    ), '[]'::json)
  ),
  CURRENT_TIMESTAMP;

-- 2. Rebuild the type.
ALTER TYPE "WorkerType" RENAME TO "WorkerType_old";
CREATE TYPE "WorkerType" AS ENUM ('EMPLOYEE', 'CONTRACTOR', 'UNPAID');

ALTER TABLE "User"
  ALTER COLUMN "workerType" TYPE "WorkerType"
  USING (
    CASE "workerType"::text
      WHEN 'TRAINEE' THEN 'EMPLOYEE'
      ELSE "workerType"::text
    END
  )::"WorkerType";

-- PolicyDocument.targetWorkerTypes is a WorkerType[] and depends on the type
-- too. Trainee-targeted policies collapse into their EMPLOYEE target, which
-- is lossless here: every policy targeting TRAINEE already targeted EMPLOYEE,
-- so the former trainee keeps all four. DISTINCT prevents a duplicate where
-- both were listed.
--
-- The mapping lives in a function because ALTER COLUMN ... USING refuses a
-- subquery, and unnesting an array needs one.
CREATE FUNCTION pg_temp.map_worker_types(arr text[]) RETURNS text[] AS $fn$
  SELECT COALESCE(
    array_agg(DISTINCT CASE x WHEN 'TRAINEE' THEN 'EMPLOYEE' ELSE x END),
    ARRAY[]::text[]
  )
  FROM unnest(arr) AS x;
$fn$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "PolicyDocument"
  ALTER COLUMN "targetWorkerTypes" TYPE "WorkerType"[]
  USING pg_temp.map_worker_types("targetWorkerTypes"::text[])::"WorkerType"[];

DROP TYPE "WorkerType_old";

-- 3. Nothing may still be TRAINEE, and nobody may have lost their type.
DO $$
DECLARE
  untyped int;
BEGIN
  SELECT count(*) INTO untyped
  FROM "User" u
  WHERE u."workerType" IS NULL
    AND EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id");

  IF untyped > 0 THEN
    RAISE EXCEPTION
      '% internal user(s) lost their worker type in the rebuild. They would resolve to zero entitlements. Rolling back.',
      untyped;
  END IF;

  -- No policy may have lost its audience.
  IF EXISTS (SELECT 1 FROM "PolicyDocument" WHERE cardinality("targetWorkerTypes") = 0) THEN
    RAISE EXCEPTION 'a policy lost every target worker type in the rebuild. Rolling back.';
  END IF;

  RAISE NOTICE 'WorkerType rebuilt: EMPLOYEE, CONTRACTOR, UNPAID';
END $$;
