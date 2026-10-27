-- `isLadderRung` — the rule `isSystem` was being asked to carry.
--
-- `isSystem` means "installed by install-starter-roles.ts", which is SEVEN
-- roles: the four ladder rungs plus Field Clearance and the two "May …"
-- exception roles. Two behaviours were gated on it and both were wrong for
-- the last three:
--
--   • at most one per person — so Field Clearance, whose entire purpose is
--     to be granted on top of Trainee, could never be granted to anybody who
--     already held a rung. Same for "May pull inventory" and "May charge
--     business expenses". Verified against dev: granting either on top of
--     Worker returned ONE_DEFAULTS_ROLE.
--   • undeletable — defensible for the ladder, arbitrary for the other three.
--
-- The exclusivity rule is about INHERITANCE, so it belongs on a marker that
-- names the inheritance chain it protects. Backfilled by key, not by name: a
-- name is a label an operator may change.
ALTER TABLE "CustomRole" ADD COLUMN "isLadderRung" BOOLEAN NOT NULL DEFAULT false;

UPDATE "CustomRole"
   SET "isLadderRung" = true
 WHERE "key" IN ('seedlings.trainee', 'seedlings.worker', 'seedlings.admin', 'seedlings.super');

-- The ladder is a single chain, so every rung except the lowest must inherit
-- from another rung. If that is not true the exclusivity rule is guarding a
-- shape that does not exist.
DO $$
DECLARE rungs int; orphans int;
BEGIN
  SELECT count(*) INTO rungs FROM "CustomRole" WHERE "isLadderRung";
  IF rungs = 0 THEN
    RAISE NOTICE 'No starter ladder installed yet — install-starter-roles.ts will set the flag.';
    RETURN;
  END IF;
  SELECT count(*) INTO orphans
    FROM "CustomRole" c
   WHERE c."isLadderRung"
     AND c."key" <> 'seedlings.trainee'
     AND (c."inheritsFromId" IS NULL
          OR NOT EXISTS (SELECT 1 FROM "CustomRole" p
                          WHERE p."id" = c."inheritsFromId" AND p."isLadderRung"));
  IF orphans > 0 THEN
    RAISE EXCEPTION '% ladder rung(s) do not inherit from another rung — the ladder is not one chain.', orphans;
  END IF;
  RAISE NOTICE 'Ladder marked: % rungs.', rungs;
END $$;
