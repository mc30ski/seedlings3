-- WATCHING THE OPERATION IS NOT WORKING IT.
--
-- The jobs feed narrowed to "visits you are assigned to" for anyone without
-- `work.claim`, and the client and property lists did the same for anyone
-- without `clients.manage`. That treats "not field-cleared" as "junior",
-- which is true of a trainee and false of a bookkeeper, an accountant or an
-- owner's partner: a read-only oversight role was handed a feed containing
-- only its own assignments, and for somebody who works no visits that is an
-- empty page.
--
-- `schedule.view-all` and `clients.view-all` name that visibility directly.
-- Granted on Admin — who already had it as a side effect of being
-- field-cleared through Worker and holding `clients.manage` — so Super and
-- District Lead inherit, and so the oversight no longer depends on Field
-- Clearance staying in the chain.
--
-- `id` is supplied: `RoleEntitlement.id` is `@default(cuid())`, generated in
-- the Prisma CLIENT, so the column has no database default.
--
-- Safe to re-run: ON CONFLICT on the (role, entitlement) unique pair.
INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, r.id, e
  FROM "CustomRole" r
  CROSS JOIN (VALUES ('schedule.view-all'), ('clients.view-all')) AS v(e)
 WHERE r.key = 'seedlings.admin'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;
