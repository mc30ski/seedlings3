-- READING THE TERRITORY IS NOT REARRANGING IT.
--
-- `areas` was the only noun in the entitlement vocabulary with a `manage`
-- and no `view`, so the only way to look at the area tree was to hold the
-- power to retire it. `areas.view` now guards the two reads
-- (`GET /areas`, `GET /area-assignments`) and the Areas tab; the seven
-- mutations keep `areas.manage`.
--
-- GRANTED ON ADMIN, NOT SUPER. Super and District Lead both inherit from
-- Admin, so one row covers all three. Without it a role holding
-- `areas.manage` alone would open the Areas tab onto a 403 — the silent
-- refusal the tab table exists to prevent.
--
-- `id` IS SUPPLIED. `RoleEntitlement.id` is `@default(cuid())`, which
-- Prisma generates in the CLIENT — the column has no database default, so
-- raw SQL that omits it inserts NULL and fails the not-null constraint.
-- That exact omission broke a production deploy on 2026-10-27.
--
-- Safe to re-run: ON CONFLICT on the (role, entitlement) unique pair.
INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, r.id, 'areas.view'
  FROM "CustomRole" r
 WHERE r.key = 'seedlings.admin'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;
