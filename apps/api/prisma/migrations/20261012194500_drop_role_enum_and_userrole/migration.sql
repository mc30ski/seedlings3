-- ─────────────────────────────────────────────────────────────────────────────
-- DROP THE `Role` ENUM AND THE `UserRole` TABLE.
--
-- The cord is cut. Nothing in the application reads either one any more:
-- every route declares the CAPABILITY it needs, and every in-handler
-- decision asks `callerCan(req, …)` against the principal the auth read
-- resolved. `requireRole` is gone, and so are `adminGuard` / `superGuard` /
-- `workerGuard`.
--
-- RUN ORDER MATTERS, and this is the LAST of three:
--
--   20261012170000_convert_roles_to_grants
--       turns every UserRole row into a custom-role grant, and REFUSES to
--       commit if anybody who held a role above STAFF would end up with
--       none. That is the step that stops this one locking the owner out.
--   20261012183000_split_money_tax_capabilities
--       splits the capabilities that guarded routes at two strictness
--       levels, so no admin silently gains the tax exports or the final say
--       over a payment.
--   this one
--       removes what is now unread.
--
-- THE DATA IS NOT LOST. Every conversion wrote an AuditEvent recording the
-- person, their legacy roles and the grant they received, so "what was Jake
-- before the cutover?" is answerable from the audit log afterwards. That
-- audit is why this is safe to run as a plain DROP rather than a rename.
--
-- WHY `STAFF` LEAVES NOTHING BEHIND. It granted no entitlements; it existed
-- so that demoting somebody left a row rather than zero, because a user with
-- zero rows was locked out of their own profile. Profile access is OWNERSHIP
-- now — `approvedUser`, which asks for no capability at all — so "on payroll,
-- holding no roles" is a valid, safe state. The seeded unpaid helper is
-- exactly that.
-- ─────────────────────────────────────────────────────────────────────────────

-- Fail loudly rather than drop silently if the conversion never ran. Without
-- this, a database whose grants were never created would lose every
-- permission it had and look like it simply had none.
DO $$
DECLARE legacy_rows int; grant_rows int;
BEGIN
  SELECT count(*) INTO legacy_rows FROM "UserRole" WHERE role <> 'STAFF';
  SELECT count(*) INTO grant_rows FROM "UserCustomRole";
  IF legacy_rows > 0 AND grant_rows = 0 THEN
    RAISE EXCEPTION
      'Refusing to drop UserRole: % row(s) above STAFF exist and NOBODY holds a custom role. Run 20261012170000_convert_roles_to_grants first.',
      legacy_rows;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "public"."UserRole" DROP CONSTRAINT "UserRole_userId_fkey";

-- DropTable
DROP TABLE "public"."UserRole";

-- DropEnum
DROP TYPE "public"."Role";
