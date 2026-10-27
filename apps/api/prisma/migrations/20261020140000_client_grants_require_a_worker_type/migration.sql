-- A CLIENT MAY NOT HOLD A DORMANT ROLE GRANT.
--
-- ───────────────────────────────────────────────────────────────────────────
-- THE RULE
--
--   A user who has an ACTIVE ClientContact and NO `workerType` may not hold
--   a `UserCustomRole` row.
--
-- A customer may absolutely also work here — that case is real and this does
-- not block it. What it blocks is the ORDER that makes it dangerous.
--
-- ───────────────────────────────────────────────────────────────────────────
-- WHY THIS AND NOT "CLIENTS MAY NOT HOLD ROLES"
--
-- Because a client who works for you is a legitimate account, so "a contact
-- may not hold entitlements" would be false. The honest invariant is narrower
-- and catches the thing that actually goes wrong.
--
-- Today a plain client resolves to zero entitlements no matter what is
-- granted to them, because `can()` returns false for a null `workerType`
-- before it ever walks their roles (the payroll gate — packages/permissions,
-- asserted in position by G31). That makes a grant to a client look harmless.
-- It is not: it is DORMANT, not void. The day anybody sets a worker type on
-- that account — promoting them, or mis-clicking in the Users tab — every
-- grant sitting on it activates at once, silently, with no approval step
-- between the mistake and the access.
--
-- So the protection used to be "two independent mistakes are required". This
-- closes the first one, which is the one nothing would ever surface:
--
--   • Promoting a customer to staff still works. Set their worker type first
--     — a deliberate, audited act that says "this person is paid like this" —
--     and then grant roles. The trigger enforces that order.
--   • A staff member who later becomes a customer keeps everything. They
--     already have a worker type, so nothing here fires.
--   • Granting a role to a plain customer is refused at the database, not
--     discovered months later when someone types a worker type.
--
-- ───────────────────────────────────────────────────────────────────────────
-- WHY A TRIGGER
--
-- The rule spans three tables (User, UserCustomRole, ClientContact), so a
-- CHECK constraint cannot express it. This is the first trigger in the
-- schema; it is deliberately the smallest one that closes the hole, and it
-- only ever REFUSES — it never edits a row, so it can surprise a reader with
-- an error but never with different data than they wrote.
--
-- The three entry points are each guarded, because the forbidden state can
-- be reached from any side:
--   1. granting a role to an unclassified customer
--   2. clearing the worker type off a customer who holds grants
--   3. attaching a customer contact to an unclassified account that holds grants
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_client_grant_has_worker_type(p_user_id text)
RETURNS void AS $$
DECLARE
  who text;
BEGIN
  SELECT u."displayName" INTO who
    FROM "User" u
   WHERE u."id" = p_user_id
     AND u."workerType" IS NULL
     AND u."clerkUserId" IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "ClientContact" cc
        WHERE cc."clerkUserId" = u."clerkUserId"
          AND cc."status" = 'ACTIVE'
     )
     AND EXISTS (SELECT 1 FROM "UserCustomRole" g WHERE g."userId" = u."id");

  IF FOUND THEN
    RAISE EXCEPTION
      'Refusing: % is an active client contact with no worker type, so a role grant would sit DORMANT until somebody sets one — and then activate silently. If they work for you, set their worker type first, then grant the role.',
      COALESCE(who, p_user_id)
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 1. Granting a role.
CREATE OR REPLACE FUNCTION public.trg_grant_requires_worker_type()
RETURNS trigger AS $$
BEGIN
  PERFORM public.assert_client_grant_has_worker_type(NEW."userId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_custom_role_requires_worker_type
AFTER INSERT OR UPDATE OF "userId" ON "UserCustomRole"
FOR EACH ROW EXECUTE FUNCTION public.trg_grant_requires_worker_type();

-- 2. Clearing a worker type off somebody who holds grants.
CREATE OR REPLACE FUNCTION public.trg_worker_type_cleared()
RETURNS trigger AS $$
BEGIN
  IF NEW."workerType" IS NULL THEN
    PERFORM public.assert_client_grant_has_worker_type(NEW."id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_worker_type_cleared_with_grants
AFTER UPDATE OF "workerType" ON "User"
FOR EACH ROW EXECUTE FUNCTION public.trg_worker_type_cleared();

-- 3. Attaching a customer contact to an account that already holds grants.
CREATE OR REPLACE FUNCTION public.trg_contact_linked_to_grantee()
RETURNS trigger AS $$
BEGIN
  IF NEW."clerkUserId" IS NOT NULL AND NEW."status" = 'ACTIVE' THEN
    PERFORM public.assert_client_grant_has_worker_type(u."id")
       FROM "User" u WHERE u."clerkUserId" = NEW."clerkUserId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_contact_linked_to_grantee
AFTER INSERT OR UPDATE OF "clerkUserId", "status" ON "ClientContact"
FOR EACH ROW EXECUTE FUNCTION public.trg_contact_linked_to_grantee();

-- A guard that only watches new writes is worth little if the state is
-- already in the table. Fail the migration rather than install a rule the
-- existing data breaks.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM "User" u
   WHERE u."workerType" IS NULL
     AND u."clerkUserId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "ClientContact" cc
                  WHERE cc."clerkUserId" = u."clerkUserId" AND cc."status" = 'ACTIVE')
     AND EXISTS (SELECT 1 FROM "UserCustomRole" g WHERE g."userId" = u."id");
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% existing account(s) are active client contacts with no worker type AND hold role grants. Those grants are dormant and would activate the moment a worker type is set. Resolve them before installing this rule.', bad;
  END IF;
  RAISE NOTICE 'Client/grant guard installed; no existing violations.';
END $$;
