-- ─────────────────────────────────────────────────────────────────────────────
-- Convert the legacy `Role` enum into custom-role grants.
--
-- This runs BEFORE the migration that drops `UserRole`, and it is the step
-- that stops the cutover locking everybody out — including the owner. After
-- it, every person's access is expressed as entitlements and the enum is
-- redundant rather than load-bearing.
--
-- IT CREATES THE ROLES ITSELF, duplicating
-- `scripts/install-starter-roles.ts`. A migration has to be self-contained:
-- it runs unattended on deploy, and one that assumed a script had been run
-- first would fail there. The script remains how you re-run or edit the set
-- later; this is only the floor.
--
-- MAPPING — the HIGHEST role each person holds, not one grant per row,
-- because the roles inherit. A SUPER does not also need the admin grant.
--
--   SUPER  → seedlings.super
--   ADMIN  → seedlings.admin
--   WORKER → seedlings.worker, UNLESS they are not cleared for field work,
--            in which case seedlings.trainee. This is the one place the
--            conversion is not a straight rename: TRAINEE used to be a
--            worker TYPE, and the people who had it are WORKER-roled
--            employees with `canPullInventory = false`. Granting them
--            seedlings.worker would hand them the field clearance the old
--            model withheld.
--   STAFF  → nothing. STAFF granted no entitlements; it existed so that
--            demoting someone left a row rather than zero. "On payroll with
--            no roles" is a valid state now, and profile access is
--            ownership, so the floor is not needed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Trainee ──
-- Adopt a same-named role that predates keys, so its id and every grant
-- pointing at it survive. Then upsert by key.
UPDATE "CustomRole" SET key = 'seedlings.trainee'
  WHERE name = 'Trainee' AND key IS NULL;

INSERT INTO "CustomRole" (id, key, name, description, "isSystem", "isPerspective", "perspectiveOrder", "inheritsFromId", "createdAt")
VALUES (gen_random_uuid()::text, 'seedlings.trainee', 'Trainee', 'Installed by migration from the legacy Role enum.', true, true, 1, NULL, now())
ON CONFLICT (key) DO UPDATE
  SET "isSystem" = true,
      "isPerspective" = true,
      "perspectiveOrder" = 1,
      "inheritsFromId" = NULL;

-- The set is REPLACED: a stale entitlement left behind is policy nobody wrote.
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.trainee')
   AND entitlement NOT IN ('clients.contribute', 'clients.view', 'equipment.view', 'estimates.accept', 'estimates.create', 'marketing.view', 'materials.charge', 'people.view', 'pricing.view', 'reports.view', 'schedule.contribute', 'schedule.view', 'supplies.view');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.trainee'), e
  FROM unnest(ARRAY['clients.contribute', 'clients.view', 'equipment.view', 'estimates.accept', 'estimates.create', 'marketing.view', 'materials.charge', 'people.view', 'pricing.view', 'reports.view', 'schedule.contribute', 'schedule.view', 'supplies.view']) AS e
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- ── Worker ──
-- Adopt a same-named role that predates keys, so its id and every grant
-- pointing at it survive. Then upsert by key.
UPDATE "CustomRole" SET key = 'seedlings.worker'
  WHERE name = 'Worker' AND key IS NULL;

INSERT INTO "CustomRole" (id, key, name, description, "isSystem", "isPerspective", "perspectiveOrder", "inheritsFromId", "createdAt")
VALUES (gen_random_uuid()::text, 'seedlings.worker', 'Worker', 'Installed by migration from the legacy Role enum.', true, true, 2, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.trainee'), now())
ON CONFLICT (key) DO UPDATE
  SET "isSystem" = true,
      "isPerspective" = true,
      "perspectiveOrder" = 2,
      "inheritsFromId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.trainee');

-- The set is REPLACED: a stale entitlement left behind is policy nobody wrote.
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.worker')
   AND entitlement NOT IN ('work.claim', 'work.complete', 'inventory.pull');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.worker'), e
  FROM unnest(ARRAY['work.claim', 'work.complete', 'inventory.pull']) AS e
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- ── Admin ──
-- Adopt a same-named role that predates keys, so its id and every grant
-- pointing at it survive. Then upsert by key.
UPDATE "CustomRole" SET key = 'seedlings.admin'
  WHERE name = 'Admin' AND key IS NULL;

INSERT INTO "CustomRole" (id, key, name, description, "isSystem", "isPerspective", "perspectiveOrder", "inheritsFromId", "createdAt")
VALUES (gen_random_uuid()::text, 'seedlings.admin', 'Admin', 'Installed by migration from the legacy Role enum.', true, true, 3, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.worker'), now())
ON CONFLICT (key) DO UPDATE
  SET "isSystem" = true,
      "isPerspective" = true,
      "perspectiveOrder" = 3,
      "inheritsFromId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.worker');

-- The set is REPLACED: a stale entitlement left behind is policy nobody wrote.
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.admin')
   AND entitlement NOT IN ('audit.view', 'books.view', 'clients.manage', 'content.manage', 'content.view', 'crews.manage', 'crews.view', 'documents.view', 'equipment.manage', 'marketing.manage', 'money.approve', 'money.record', 'money.view', 'notify.send', 'payroll.view', 'people.manage', 'schedule.manage', 'supplies.manage', 'time.approve');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.admin'), e
  FROM unnest(ARRAY['audit.view', 'books.view', 'clients.manage', 'content.manage', 'content.view', 'crews.manage', 'crews.view', 'documents.view', 'equipment.manage', 'marketing.manage', 'money.approve', 'money.record', 'money.view', 'notify.send', 'payroll.view', 'people.manage', 'schedule.manage', 'supplies.manage', 'time.approve']) AS e
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- ── Super ──
-- Adopt a same-named role that predates keys, so its id and every grant
-- pointing at it survive. Then upsert by key.
UPDATE "CustomRole" SET key = 'seedlings.super'
  WHERE name = 'Super' AND key IS NULL;

INSERT INTO "CustomRole" (id, key, name, description, "isSystem", "isPerspective", "perspectiveOrder", "inheritsFromId", "createdAt")
VALUES (gen_random_uuid()::text, 'seedlings.super', 'Super', 'Installed by migration from the legacy Role enum.', true, true, 4, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.admin'), now())
ON CONFLICT (key) DO UPDATE
  SET "isSystem" = true,
      "isPerspective" = true,
      "perspectiveOrder" = 4,
      "inheritsFromId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.admin');

-- The set is REPLACED: a stale entitlement left behind is policy nobody wrote.
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.super')
   AND entitlement NOT IN ('areas.manage', 'books.manage', 'compliance.manage', 'compliance.view', 'displays.manage', 'documents.manage', 'forecasts.view', 'identity.link', 'payroll.manage', 'people.grant-roles', 'pricing.manage', 'roles.define', 'routes.plan', 'settings.manage', 'time.view');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.super'), e
  FROM unnest(ARRAY['areas.manage', 'books.manage', 'compliance.manage', 'compliance.view', 'displays.manage', 'documents.manage', 'forecasts.view', 'identity.link', 'payroll.manage', 'people.grant-roles', 'pricing.manage', 'roles.define', 'routes.plan', 'settings.manage', 'time.view']) AS e
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- ── Field Clearance ──
-- Adopt a same-named role that predates keys, so its id and every grant
-- pointing at it survive. Then upsert by key.
UPDATE "CustomRole" SET key = 'seedlings.field-clearance'
  WHERE name = 'Field Clearance' AND key IS NULL;

INSERT INTO "CustomRole" (id, key, name, description, "isSystem", "isPerspective", "perspectiveOrder", "inheritsFromId", "createdAt")
VALUES (gen_random_uuid()::text, 'seedlings.field-clearance', 'Field Clearance', 'Installed by migration from the legacy Role enum.', true, false, NULL, NULL, now())
ON CONFLICT (key) DO UPDATE
  SET "isSystem" = true,
      "isPerspective" = false,
      "perspectiveOrder" = NULL,
      "inheritsFromId" = NULL;

-- The set is REPLACED: a stale entitlement left behind is policy nobody wrote.
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.field-clearance')
   AND entitlement NOT IN ('work.claim', 'work.complete', 'inventory.pull');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, (SELECT id FROM "CustomRole" WHERE key = 'seedlings.field-clearance'), e
  FROM unnest(ARRAY['work.claim', 'work.complete', 'inventory.pull']) AS e
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- ── Grant the highest role each person holds ─────────────────────────────
INSERT INTO "UserCustomRole" (id, "userId", "customRoleId", "grantedAt")
SELECT gen_random_uuid()::text, u.id, cr.id, now()
  FROM "User" u
  JOIN LATERAL (
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM "UserRole" r WHERE r."userId" = u.id AND r.role = 'SUPER')  THEN 'seedlings.super'
      WHEN EXISTS (SELECT 1 FROM "UserRole" r WHERE r."userId" = u.id AND r.role = 'ADMIN')  THEN 'seedlings.admin'
      WHEN EXISTS (SELECT 1 FROM "UserRole" r WHERE r."userId" = u.id AND r.role = 'WORKER')
        THEN CASE WHEN u."canPullInventory" IS FALSE THEN 'seedlings.trainee' ELSE 'seedlings.worker' END
      ELSE NULL
    END AS target_key
  ) t ON true
  JOIN "CustomRole" cr ON cr.key = t.target_key
ON CONFLICT ("userId", "customRoleId") DO NOTHING;

-- ── Audit, before the evidence is dropped ────────────────────────────────
INSERT INTO "AuditEvent" (id, scope, verb, "actorUserId", metadata, "createdAt")
SELECT gen_random_uuid()::text, 'ROLE', 'ROLE_ASSIGNED', NULL,
       jsonb_build_object(
         'userId', u.id,
         'email', u.email,
         'legacyRoles', (SELECT jsonb_agg(r.role::text ORDER BY r.role) FROM "UserRole" r WHERE r."userId" = u.id),
         'grantedRoleKey', cr.key,
         'why', 'Converted from the Role enum before it was dropped.'
       ),
       now()
  FROM "User" u
  JOIN "UserCustomRole" ucr ON ucr."userId" = u.id
  JOIN "CustomRole" cr ON cr.id = ucr."customRoleId" AND cr.key LIKE 'seedlings.%'
 WHERE EXISTS (SELECT 1 FROM "UserRole" r WHERE r."userId" = u.id AND r.role <> 'STAFF');

-- ── Assert nobody lost access ────────────────────────────────────────────
-- Anyone who held a role above STAFF must now hold a custom role. If this
-- fires the whole migration rolls back, which is the only acceptable
-- outcome: the alternative is a deploy that silently locks the owner out of
-- their own business.
DO $$
DECLARE orphaned int;
BEGIN
  SELECT count(*) INTO orphaned
    FROM "User" u
   WHERE EXISTS (SELECT 1 FROM "UserRole" r WHERE r."userId" = u.id AND r.role <> 'STAFF')
     AND NOT EXISTS (SELECT 1 FROM "UserCustomRole" g WHERE g."userId" = u.id);
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Role conversion would strip access from % user(s) who hold a role above STAFF. Rolling back.', orphaned;
  END IF;
END $$;
