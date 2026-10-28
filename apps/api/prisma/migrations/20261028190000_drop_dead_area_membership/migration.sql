-- Drop AreaMembership: a table nothing ever read or wrote.
--
-- It was added with the area tree (20261011235000_add_area_tree) to mean
-- "this person usually works here" — informational, granting nothing, with
-- G17 asserting that no permission check consulted it. The check was the
-- only thing that ever referred to it. No service, route, page or script in
-- apps/api, apps/web or packages has ever touched the model, so the table
-- has sat empty in every environment since it was created (verified 0 rows
-- in dev and production on 2026-10-28) while the permissions model grew up
-- around it.
--
-- It is dropped rather than left alone because an empty second area table is
-- an invitation: the next person reads two area relations on User and
-- reasonably assumes authorization consults both. There is ONE area relation
-- that means anything — AreaAssignment — and it grants. A home base, if one
-- is ever wanted, belongs on User.homeBaseAddress, which no authorization
-- path reads either. G17 now asserts the model stays gone.
--
-- The guard below is belt-and-braces. Both databases are empty today, so it
-- cannot fire; it exists so that if some future branch starts writing rows
-- before this lands, the migration stops instead of deleting them.
DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public."AreaMembership"') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM "AreaMembership"' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'AreaMembership holds % row(s). It was dropped as dead code; something started using it. Resolve before dropping.', n;
  END IF;
END $$;

ALTER TABLE "public"."AreaMembership" DROP CONSTRAINT IF EXISTS "AreaMembership_areaId_fkey";
ALTER TABLE "public"."AreaMembership" DROP CONSTRAINT IF EXISTS "AreaMembership_userId_fkey";
DROP TABLE IF EXISTS "public"."AreaMembership";
