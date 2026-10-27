-- Former TRAINEEs are UNPAID, not EMPLOYEE.
--
-- WHY THIS EXISTS
-- `20261012011000_workertype_drop_trainee_add_unpaid` folded TRAINEE into
-- EMPLOYEE, reasoning that a trainee was already EMPLOYEE for every money
-- purpose and that the real distinction was field clearance. That holds as a
-- general claim and did not hold for the person it actually lands on: the one
-- TRAINEE in production is not paid at all. EMPLOYEE would put them in the
-- W-2 base, make them eligible for a paid seat, and let `rateFor` price them.
--
-- The earlier migration is applied, so it is frozen — this corrects the
-- result rather than rewriting the cause. It reads the `formerTrainees` list
-- that migration deliberately recorded in an AuditEvent before destroying the
-- information, which is the only surviving record of who they were.
--
-- WHY IT REFUSES RATHER THAN REPAIRS
-- An UNPAID person may only hold an OBSERVER seat (G33), and demoting a
-- claimer can leave an occurrence with workers and no claimer — the state
-- `enforceAssigneeInvariants` and `npm run repair:claimers` exist to prevent.
-- Reproducing that repair in SQL would be a second implementation of a rule
-- that already has one. So this refuses loudly if a former trainee holds a
-- paid seat or has any money history, and the operator resolves it with the
-- tools built for it before re-running.

DO $$
DECLARE
  ids text[];
  blocked int;
  changed int;
BEGIN
  -- Who was a trainee, per the audit row the earlier migration wrote.
  SELECT COALESCE(array_agg(DISTINCT t->>'userId'), ARRAY[]::text[])
    INTO ids
    FROM "AuditEvent" a,
         LATERAL jsonb_array_elements((a."metadata"::jsonb)->'formerTrainees') AS t
   WHERE a."metadata"::jsonb->>'migration' = '20261012011000_workertype_drop_trainee_add_unpaid';

  IF cardinality(ids) = 0 THEN
    RAISE NOTICE 'No former trainees recorded — nothing to correct.';
    RETURN;
  END IF;

  -- A seat the money system would try to pay, or any money already moved.
  SELECT count(*) INTO blocked
    FROM "User" u
   WHERE u."id" = ANY(ids)
     AND (
       EXISTS (SELECT 1 FROM "JobOccurrenceAssignee" s
                WHERE s."userId" = u."id" AND COALESCE(s."role", '') <> 'observer')
       OR EXISTS (SELECT 1 FROM "PayrollEntry" pe WHERE pe."userId" = u."id")
       OR EXISTS (SELECT 1 FROM "PaymentSplit" ps WHERE ps."userId" = u."id")
     );

  IF blocked > 0 THEN
    RAISE EXCEPTION
      '% former trainee(s) hold a paid seat or have payroll/payment history. Marking them UNPAID would break G33 and could strand an occurrence without a claimer. Demote their seats to observer (npm run repair:claimers) or reconsider their worker type, then re-run.',
      blocked;
  END IF;

  UPDATE "User"
     SET "workerType" = 'UNPAID'
   WHERE "id" = ANY(ids)
     AND "workerType" = 'EMPLOYEE';
  GET DIAGNOSTICS changed = ROW_COUNT;

  -- Every state change writes its own audit row, including this one. Actor is
  -- NULL because a migration has no signed-in caller.
  IF changed > 0 THEN
    INSERT INTO "AuditEvent" ("id", "scope", "verb", "actorUserId", "metadata", "createdAt")
    SELECT
      gen_random_uuid()::text, 'USER'::"AuditScope", 'WORKER_TYPE_SET'::"AuditVerb", NULL,
      json_build_object(
        'migration', '20261020120000_former_trainees_are_unpaid',
        'from', 'EMPLOYEE',
        'to', 'UNPAID',
        'note', 'Former TRAINEE folded into EMPLOYEE by 20261012011000. They are not paid, so EMPLOYEE put them in the W-2 base and made them eligible for a paid seat.',
        'users', COALESCE((
          SELECT json_agg(json_build_object('userId', u."id", 'displayName', u."displayName"))
          FROM "User" u WHERE u."id" = ANY(ids) AND u."workerType" = 'UNPAID'
        ), '[]'::json)
      ),
      CURRENT_TIMESTAMP;
  END IF;

  RAISE NOTICE 'Former trainees set to UNPAID: %', changed;
END $$;

-- Nothing recorded as a former trainee may still be EMPLOYEE.
DO $$
DECLARE still int;
BEGIN
  SELECT count(*) INTO still
    FROM "User" u
   WHERE u."workerType" = 'EMPLOYEE'
     AND u."id" IN (
       SELECT t->>'userId'
         FROM "AuditEvent" a,
              LATERAL jsonb_array_elements((a."metadata"::jsonb)->'formerTrainees') AS t
        WHERE a."metadata"::jsonb->>'migration' = '20261012011000_workertype_drop_trainee_add_unpaid'
     );
  IF still > 0 THEN
    RAISE EXCEPTION '% former trainee(s) are still EMPLOYEE after the correction. Rolling back.', still;
  END IF;
END $$;
