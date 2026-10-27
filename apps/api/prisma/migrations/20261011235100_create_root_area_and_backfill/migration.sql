-- Create the root area and backfill EVERY existing row.
--
-- Decision 36, and it is not optional: without the backfill every rollup
-- returns zero on day one, every property shows as unassigned, and the
-- feature looks broken rather than empty. The root exists so nothing starts
-- invisible.
--
-- The path is a materialized list of IDS, delimited AND terminated:
-- "/<root>/". Ids because names are neither unique nor stable — two areas may
-- both be called "Raleigh", and a rename must not move anything. The trailing
-- delimiter is load-bearing: "/a/b/" is a prefix of "/a/b/c/" but not of
-- "/a/bb/", which is what stops a grant leaking into a sibling territory.

-- ── The root ───────────────────────────────────────────────────────────────
INSERT INTO "Area" ("id", "name", "tier", "parentId", "path", "createdAt")
SELECT
  gen_random_uuid()::text,
  'All areas',
  NULL,
  NULL,
  '',            -- replaced below, once the id is known
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Area" WHERE "parentId" IS NULL);

-- A root's path is just itself.
UPDATE "Area" SET "path" = '/' || "id" || '/'
WHERE "parentId" IS NULL AND "path" = '';

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Everything that can carry an area gets the root, so no surface starts
-- empty and no money is unattributed.
UPDATE "Property" p
SET "areaId" = (SELECT "id" FROM "Area" WHERE "parentId" IS NULL LIMIT 1)
WHERE p."areaId" IS NULL;

UPDATE "JobOccurrence" o
SET "areaId" = (SELECT "id" FROM "Area" WHERE "parentId" IS NULL LIMIT 1)
WHERE o."areaId" IS NULL;

UPDATE "Job" j
SET "defaultAreaId" = (SELECT "id" FROM "Area" WHERE "parentId" IS NULL LIMIT 1)
WHERE j."defaultAreaId" IS NULL;

-- ── Audit ──────────────────────────────────────────────────────────────────
-- Every state change writes an AuditEvent. Creating the territory that
-- decides who sees what money is not an exception. The AREA scope is usable
-- here because the previous migration committed it.
INSERT INTO "AuditEvent" ("id", "scope", "verb", "actorUserId", "metadata", "createdAt")
SELECT
  gen_random_uuid()::text, 'AREA'::"AuditScope", 'CREATED'::"AuditVerb", NULL,
  json_build_object(
    'migration', '20261011235100_create_root_area_and_backfill',
    'rootAreaId', a."id",
    'rootAreaPath', a."path",
    'backfilled', json_build_object(
      'properties',    (SELECT count(*) FROM "Property"      WHERE "areaId" = a."id"),
      'occurrences',   (SELECT count(*) FROM "JobOccurrence" WHERE "areaId" = a."id"),
      'jobDefaults',   (SELECT count(*) FROM "Job"           WHERE "defaultAreaId" = a."id")
    )
  ),
  CURRENT_TIMESTAMP
FROM "Area" a WHERE a."parentId" IS NULL;

-- ── Assertions ─────────────────────────────────────────────────────────────
-- Nothing may be left unattributed, and the root's path must be well formed.
-- A failure rolls the whole migration back.
DO $$
DECLARE
  root_id   text;
  root_path text;
  orphans   int;
BEGIN
  SELECT "id", "path" INTO root_id, root_path FROM "Area" WHERE "parentId" IS NULL;
  IF root_id IS NULL THEN
    RAISE EXCEPTION 'no root area was created';
  END IF;
  IF root_path <> '/' || root_id || '/' THEN
    RAISE EXCEPTION 'root path % is not the delimited form /<id>/ — prefix matching would be wrong', root_path;
  END IF;

  SELECT
    (SELECT count(*) FROM "Property"      WHERE "areaId" IS NULL)
  + (SELECT count(*) FROM "JobOccurrence" WHERE "areaId" IS NULL)
  + (SELECT count(*) FROM "Job"           WHERE "defaultAreaId" IS NULL)
  INTO orphans;

  IF orphans <> 0 THEN
    RAISE EXCEPTION
      '% row(s) still have no area. Every rollup would under-report by exactly that much. Rolling back.',
      orphans;
  END IF;

  RAISE NOTICE 'root area % created and every row backfilled', root_id;
END $$;
