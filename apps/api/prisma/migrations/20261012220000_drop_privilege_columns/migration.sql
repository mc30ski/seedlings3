-- ─────────────────────────────────────────────────────────────────────────────
-- DROP `User.canPullInventory` and `User.canChargeBusinessExpenses`.
--
-- These were per-person privilege ticks: three-state columns (true / false /
-- null-means-follow-the-worker-type-default) that decided whether somebody
-- could take stock out or put the company's spend on the books.
--
-- WHY THEY GO
--   1. They are a PER-PERSON ENTITLEMENT GRANT, which this model forbids
--      outright (G20). The cost of forbidding it is that an exception needs
--      its own named role; the benefit is that "why can Jake pull
--      inventory?" has exactly one kind of answer, visible in a role list
--      rather than hidden on a profile nobody thinks to open.
--   2. They were a SECOND SOURCE OF TRUTH for facts the roles already state.
--      Field clearance is `inventory.pull`; charging the card is
--      `expenses.charge`. Two stores for one fact can disagree, and this
--      pair already had: a reseed rewrote the columns while leaving the
--      grants alone, so the same person read as cleared through one path and
--      uncleared through the other.
--
-- NOTHING IS LOST. 20261011234500_privilege_columns_to_grants already
-- converted every effective value into a role grant, with an in-transaction
-- count assertion and an audit snapshot. This only removes what is no longer
-- read.
--
-- `PATCH /admin/users/:id/privileges` and `users.setPrivilegeOverrides` are
-- deleted with them. Granting either capability is now
-- `POST /super/users/:id/roles`.
-- ─────────────────────────────────────────────────────────────────────────────

-- Refuse if the conversion never ran: dropping an explicit `false` with no
-- role to replace it would silently GRANT clearance to somebody it was
-- deliberately withheld from.
DO $$
DECLARE explicit_denies int; grant_rows int;
BEGIN
  SELECT count(*) INTO explicit_denies
    FROM "User"
   WHERE "canPullInventory" IS FALSE OR "canChargeBusinessExpenses" IS FALSE;
  SELECT count(*) INTO grant_rows FROM "UserCustomRole";
  IF explicit_denies > 0 AND grant_rows = 0 THEN
    RAISE EXCEPTION
      'Refusing to drop the privilege columns: % row(s) carry an explicit denial and nobody holds a role. Run 20261011234500_privilege_columns_to_grants first.',
      explicit_denies;
  END IF;
END $$;

ALTER TABLE "User" DROP COLUMN "canPullInventory";
ALTER TABLE "User" DROP COLUMN "canChargeBusinessExpenses";
