-- ─────────────────────────────────────────────────────────────────────────────
-- Split the money and tax capabilities, and re-apply the starter ladder.
--
-- WHY
-- Collapsing the legacy roles into entitlements exposed that 25 capabilities
-- guarded routes at TWO different strictness levels. One capability can only
-- have one, so collapsing either way changed somebody's access:
--
--   money.approve    admin: recalculate-splits, admin-mark-paid
--                    super: approve, reject, revert, skip, write-off, edit, delete
--   books.view       admin: holdings, ledger charges, export summary
--                    super: business expenses, the P&L, FOUR TAX CSVs, reconcile
--   time.approve     admin: approve hours on a visit
--                    super: create and edit workdays and mileage
--   supplies.manage  admin: per-visit holds
--                    super: the catalog, purchases, adjustments
--
-- Collapsing DOWN would have given every admin the power to approve payments,
-- download the tax exports, rewrite a timesheet and buy supplies. Collapsing
-- UP would have taken away work admins do every day. So the money and tax
-- ones were SPLIT by what the routes actually do, and four capabilities are
-- new:
--
--   money.adjust      rework how a payment divides between the crew   (Admin)
--   books.export-tax  the files that go to the accountant             (Super)
--   time.manage       rewrite the timesheet itself                    (Super)
--   supplies.hold     reserve stock against a visit                   (Admin)
--
-- Isolating `books.export-tax` is the point: it is the only capability that
-- hands somebody the tax filings, and it no longer travels with "can look at
-- the expense list".
--
-- Everything NOT money or tax collapses DOWN, deliberately. Those remaining
-- splits are a route returning more detail to an admin than to a worker,
-- which is redaction's job and not the gate's.
--
-- IDEMPOTENT, and keyed on `key` not `name`, so an operator who renamed a
-- role still gets the update. Sets are REPLACED: an entitlement left behind
-- is policy nobody wrote.
-- ─────────────────────────────────────────────────────────────────────────────

-- seedlings.trainee: 13 own entitlement(s)
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.trainee')
   AND entitlement NOT IN ('clients.contribute', 'clients.view', 'equipment.view', 'estimates.accept', 'estimates.create', 'marketing.view', 'materials.charge', 'people.view', 'pricing.view', 'reports.view', 'schedule.contribute', 'schedule.view', 'supplies.view');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, cr.id, e
  FROM "CustomRole" cr, unnest(ARRAY['clients.contribute', 'clients.view', 'equipment.view', 'estimates.accept', 'estimates.create', 'marketing.view', 'materials.charge', 'people.view', 'pricing.view', 'reports.view', 'schedule.contribute', 'schedule.view', 'supplies.view']) AS e
 WHERE cr.key = 'seedlings.trainee'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- seedlings.worker: 3 own entitlement(s)
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.worker')
   AND entitlement NOT IN ('inventory.pull', 'work.claim', 'work.complete');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, cr.id, e
  FROM "CustomRole" cr, unnest(ARRAY['inventory.pull', 'work.claim', 'work.complete']) AS e
 WHERE cr.key = 'seedlings.worker'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- seedlings.admin: 20 own entitlement(s)
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.admin')
   AND entitlement NOT IN ('audit.view', 'books.view', 'clients.manage', 'content.manage', 'content.view', 'crews.manage', 'crews.view', 'documents.view', 'equipment.manage', 'identity.link', 'marketing.manage', 'money.adjust', 'money.record', 'money.view', 'notify.send', 'payroll.view', 'people.manage', 'schedule.manage', 'supplies.hold', 'time.approve');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, cr.id, e
  FROM "CustomRole" cr, unnest(ARRAY['audit.view', 'books.view', 'clients.manage', 'content.manage', 'content.view', 'crews.manage', 'crews.view', 'documents.view', 'equipment.manage', 'identity.link', 'marketing.manage', 'money.adjust', 'money.record', 'money.view', 'notify.send', 'payroll.view', 'people.manage', 'schedule.manage', 'supplies.hold', 'time.approve']) AS e
 WHERE cr.key = 'seedlings.admin'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- seedlings.super: 18 own entitlement(s)
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.super')
   AND entitlement NOT IN ('areas.manage', 'books.export-tax', 'books.manage', 'compliance.manage', 'compliance.view', 'displays.manage', 'documents.manage', 'forecasts.view', 'money.approve', 'payroll.manage', 'people.grant-roles', 'pricing.manage', 'roles.define', 'routes.plan', 'settings.manage', 'supplies.manage', 'time.manage', 'time.view');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, cr.id, e
  FROM "CustomRole" cr, unnest(ARRAY['areas.manage', 'books.export-tax', 'books.manage', 'compliance.manage', 'compliance.view', 'displays.manage', 'documents.manage', 'forecasts.view', 'money.approve', 'payroll.manage', 'people.grant-roles', 'pricing.manage', 'roles.define', 'routes.plan', 'settings.manage', 'supplies.manage', 'time.manage', 'time.view']) AS e
 WHERE cr.key = 'seedlings.super'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- seedlings.field-clearance: 3 own entitlement(s)
DELETE FROM "RoleEntitlement"
 WHERE "customRoleId" = (SELECT id FROM "CustomRole" WHERE key = 'seedlings.field-clearance')
   AND entitlement NOT IN ('inventory.pull', 'work.claim', 'work.complete');

INSERT INTO "RoleEntitlement" (id, "customRoleId", entitlement)
SELECT gen_random_uuid()::text, cr.id, e
  FROM "CustomRole" cr, unnest(ARRAY['inventory.pull', 'work.claim', 'work.complete']) AS e
 WHERE cr.key = 'seedlings.field-clearance'
ON CONFLICT ("customRoleId", entitlement) DO NOTHING;

-- ── Assert every new capability reached a role ───────────────────────────
-- A capability that reaches nobody makes the routes it guards unreachable by
-- anyone, including the owner — a silent lockout rather than a loud failure.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(e, ', ') INTO missing
    FROM unnest(ARRAY['money.adjust','books.export-tax','time.manage','supplies.hold']) AS e
   WHERE NOT EXISTS (SELECT 1 FROM "RoleEntitlement" re WHERE re.entitlement = e);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Split failed: % reached no role, so the routes they guard are unreachable by anyone.', missing;
  END IF;
END $$;
