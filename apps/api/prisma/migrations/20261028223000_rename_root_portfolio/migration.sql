-- Rename the root node "All areas" → "All properties".
--
-- WHY THIS IS A SEPARATE MIGRATION. `20261028210000_area_becomes_portfolio`
-- renamed the TABLE and left the ROW alone, which looked conservative and
-- was not. The seed finds the root by name:
--
--     where: { parentId: null, name: "All properties" }
--
-- so with the row still called "All areas" it found nothing, created a
-- SECOND root, and rebuilt the whole district tree underneath it. Two roots
-- is a state the model does not have: `PORTFOLIO_IS_THE_ROOT` asks whether
-- `parentId IS NULL` and the materialised path assumes one coordinate
-- system. Dev produced exactly that on the first reseed after the rename.
--
-- ONLY IF IT IS STILL THE NAME WE SHIPPED. The root's label belongs to the
-- operator — they can rename it, and `install-starter-roles` is explicit
-- that a migration must not overwrite a label somebody chose. So this
-- matches the exact string the old seed wrote and nothing else. A root
-- renamed to "All territories" or "Everything" is left alone, and the
-- operator can align it themselves.
UPDATE "Portfolio"
   SET "name" = 'All properties'
 WHERE "parentId" IS NULL
   AND "name" = 'All areas';
