-- Backfill the STAFF floor onto existing internal users.
--
-- WHY THIS EXISTS
-- STAFF grants nothing extra. Its only job is to be the row that survives
-- when every other role is removed: without it, demoting someone leaves zero
-- UserRole rows, and a user with zero rows is locked out of their own
-- profile.
--
-- 20261011232131_add_staff_role_and_custom_roles added the enum value but no
-- data, so every account predating it still sits below the floor. That
-- migration is already applied and is never edited; this is its companion.
--
-- WHY THE PREDICATE IS "HOLDS WORKER"
-- A signed-in ClientContact holds no roles at all, and granting them STAFF
-- would make them internal staff. WORKER is the right population because the
-- app maintains ADMIN => WORKER in both directions: granting ADMIN also
-- grants WORKER (UsersTab addRole), and "Remove Worker" is disabled for
-- admins with the tooltip "Admins must keep Worker role". So no internal user
-- holds ADMIN or SUPER without also holding WORKER.
--
-- WHY THE ID IS GENERATED HERE
-- UserRole.id has no database default — Prisma's @default(cuid()) runs in the
-- client, not in Postgres. gen_random_uuid() is built in from PG13 (this is
-- PG17); the value is only ever an opaque primary key.
--
-- IDEMPOTENT via ON CONFLICT against @@unique([userId, role]), so re-running
-- it against a database that already has these rows is a no-op.

INSERT INTO "UserRole" ("id", "userId", "role")
SELECT gen_random_uuid()::text, w."userId", 'STAFF'::"Role"
FROM (SELECT DISTINCT "userId" FROM "UserRole" WHERE "role" = 'WORKER') AS w
ON CONFLICT ("userId", "role") DO NOTHING;
