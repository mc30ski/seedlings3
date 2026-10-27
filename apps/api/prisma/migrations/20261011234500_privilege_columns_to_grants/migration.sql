-- Convert the two per-person privilege columns into named-role grants.
--
-- WHAT THIS DOES NOT DO: drop the columns. Decision 15i says to drop them in
-- this same migration, and G24 says both guard paths must work while the flag
-- exists. Those conflict: `resolvePrivileges` reads these columns, so dropping
-- them leaves `inventory.pull` and `expenses.charge` with NO legacy path while
-- ENTITLEMENTS_ENABLED is off — the flag would still recover the other 43
-- entitlements and silently not these two, which is the worst kind of partial.
-- The columns are dropped in the same follow-up that deletes the old role
-- guards, which the design already schedules. 15i's intent (no dead columns
-- left for someone to rewire) is honoured there.
--
-- G20 FORBIDS PER-PERSON GRANTS, so a user whose override DIVERGES from their
-- worker-type default cannot be expressed by attaching a Defaults role. Each
-- divergent combination becomes a NAMED role instead — visible, reusable, and
-- answerable when someone asks "why does this person have that".
--
-- Admins and supers are not listed here: `resolvePrivileges` grants them both
-- privileges unconditionally, and both now sit in their base bundles.

-- ── Exception roles for the divergent cases ────────────────────────────────
INSERT INTO "CustomRole" ("id", "name", "description", "isSystem", "createdAt")
VALUES
  (gen_random_uuid()::text, 'Trainee — may pull inventory',
   'Overrides the trainee default so this person can take equipment and supplies out for a job. Created by the privilege-column migration from an explicit per-person override.',
   false, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'May charge business expenses',
   'Lets a non-admin charge the company''s own purchases to the business. Created by the privilege-column migration from an explicit per-person override.',
   false, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "RoleEntitlement" ("id", "customRoleId", "entitlement")
SELECT gen_random_uuid()::text, r."id", 'inventory.pull'
FROM "CustomRole" r WHERE r."name" = 'Trainee — may pull inventory'
ON CONFLICT ("customRoleId", "entitlement") DO NOTHING;

INSERT INTO "RoleEntitlement" ("id", "customRoleId", "entitlement")
SELECT gen_random_uuid()::text, r."id", 'expenses.charge'
FROM "CustomRole" r WHERE r."name" = 'May charge business expenses'
ON CONFLICT ("customRoleId", "entitlement") DO NOTHING;

-- ── Snapshot BEFORE anything is derived from the columns ───────────────────
-- The repo rule is that destructive paths snapshot first. The columns survive
-- this migration, but the DERIVATION happens here, so this is the moment the
-- inputs matter.
INSERT INTO "AuditEvent" ("id", "scope", "verb", "actorUserId", "metadata", "createdAt")
SELECT
  gen_random_uuid()::text, 'ROLE'::"AuditScope", 'UPDATED'::"AuditVerb", NULL,
  json_build_object(
    'migration', '20261011234500_privilege_columns_to_grants',
    'source', 'privilege_column_conversion',
    'users', (
      SELECT json_agg(json_build_object(
        'userId', u."id",
        'displayName', u."displayName",
        'workerType', u."workerType",
        'canPullInventoryColumn', u."canPullInventory",
        'canChargeBusinessExpensesColumn', u."canChargeBusinessExpenses"
      ))
      FROM "User" u
      WHERE EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id")
    )
  ),
  CURRENT_TIMESTAMP;

-- ── Assign the exception roles to whoever diverges ─────────────────────────
-- Trainees with an explicit pull override of TRUE.
INSERT INTO "UserCustomRole" ("id", "userId", "customRoleId", "grantedAt")
SELECT gen_random_uuid()::text, u."id", r."id", CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN "CustomRole" r
WHERE r."name" = 'Trainee — may pull inventory'
  AND u."workerType" = 'TRAINEE'
  AND u."canPullInventory" IS TRUE
  AND EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id")
ON CONFLICT ("userId", "customRoleId") DO NOTHING;

-- Non-admins with an explicit charge override of TRUE.
INSERT INTO "UserCustomRole" ("id", "userId", "customRoleId", "grantedAt")
SELECT gen_random_uuid()::text, u."id", r."id", CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN "CustomRole" r
WHERE r."name" = 'May charge business expenses'
  AND u."canChargeBusinessExpenses" IS TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "UserRole" ur
    WHERE ur."userId" = u."id" AND ur."role" IN ('ADMIN', 'SUPER')
  )
  AND EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id")
ON CONFLICT ("userId", "customRoleId") DO NOTHING;

-- ── The assertion that makes this safe ─────────────────────────────────────
-- Count the users whose EFFECTIVE privilege is true (column override first,
-- then the worker-type default, with admin/super always true) and require it
-- to equal the number who now resolve it through a grant or a base bundle.
-- A mismatch raises, and the whole migration rolls back.
DO $$
DECLARE
  eff_pull   int;
  res_pull   int;
  eff_charge int;
  res_charge int;
BEGIN
  -- Mirrors resolvePrivileges EXACTLY: admin/super short-circuits to true
  -- before any column or default is consulted. Leaving that out is what made
  -- the first run of this migration roll itself back.
  SELECT count(*) INTO eff_pull FROM "User" u
  WHERE EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id")
    AND (
      EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id" AND ur."role" IN ('ADMIN','SUPER'))
      OR COALESCE(
           u."canPullInventory",
           CASE WHEN u."workerType" IS NULL THEN false
                WHEN u."workerType" = 'TRAINEE' THEN false
                ELSE true END
         ) IS TRUE
    );

  -- Resolves through: an admin/super base bundle, a Defaults role, or an
  -- exception role.
  SELECT count(DISTINCT u."id") INTO res_pull FROM "User" u
  WHERE EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id" AND ur."role" IN ('ADMIN','SUPER'))
     OR EXISTS (
       SELECT 1 FROM "UserCustomRole" ucr
       JOIN "RoleEntitlement" re ON re."customRoleId" = ucr."customRoleId"
       WHERE ucr."userId" = u."id" AND re."entitlement" = 'inventory.pull'
     );

  SELECT count(*) INTO eff_charge FROM "User" u
  WHERE EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id")
    AND (
      EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id" AND ur."role" IN ('ADMIN','SUPER'))
      OR COALESCE(u."canChargeBusinessExpenses", false) IS TRUE
    );

  SELECT count(DISTINCT u."id") INTO res_charge FROM "User" u
  WHERE EXISTS (SELECT 1 FROM "UserRole" ur WHERE ur."userId" = u."id" AND ur."role" IN ('ADMIN','SUPER'))
     OR EXISTS (
       SELECT 1 FROM "UserCustomRole" ucr
       JOIN "RoleEntitlement" re ON re."customRoleId" = ucr."customRoleId"
       WHERE ucr."userId" = u."id" AND re."entitlement" = 'expenses.charge'
     );

  IF eff_pull <> res_pull THEN
    RAISE EXCEPTION
      'inventory.pull conversion lost someone: % users had it effectively, % resolve it now. Rolling back.',
      eff_pull, res_pull;
  END IF;

  IF eff_charge <> res_charge THEN
    RAISE EXCEPTION
      'expenses.charge conversion lost someone: % users had it effectively, % resolve it now. Rolling back.',
      eff_charge, res_charge;
  END IF;

  RAISE NOTICE 'privilege conversion verified: inventory.pull %, expenses.charge %', res_pull, res_charge;
END $$;
