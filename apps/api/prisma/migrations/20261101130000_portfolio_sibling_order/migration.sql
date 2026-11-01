-- Portfolio sibling order — DISPLAY ONLY.
--
-- Where a node sits among its siblings. It is not in any path, nothing
-- filters on it, and no history resolves through it. That is what makes it
-- unlike reparenting (G14): moving a node between parents rewrites the
-- materialized path of every descendant and restates what every
-- portfolio-scoped query returns, while moving one up past its sibling
-- changes a list's order and nothing else.
ALTER TABLE "Portfolio" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- SEEDED FROM WHAT IS ON SCREEN TODAY, so deploying this changes nothing
-- visible. Every existing node is numbered within its parent in the order
-- it is currently listed, which is `path` ascending. Leaving them all at 0
-- would have made the first reorder swap two equal values and appear to do
-- nothing.
--
-- `parentId IS NULL` groups the roots together: in Postgres PARTITION BY
-- treats NULLs as one group, which is what is wanted here — the roots are
-- siblings of each other.
WITH ordered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "parentId" ORDER BY "path" ASC) - 1 AS n
  FROM "Portfolio"
)
UPDATE "Portfolio" p
   SET "sortOrder" = ordered.n
  FROM ordered
 WHERE ordered."id" = p."id";
