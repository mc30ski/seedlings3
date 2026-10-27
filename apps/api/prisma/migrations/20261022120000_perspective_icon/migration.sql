-- An icon for each perspective, as a stable key.
--
-- The dropdown had icons before the roles refactor — Client a house, Worker
-- a person, Admin a badge, Super a shield — and they were lost when the
-- four hardcoded shells became operator-defined roles, because the icon
-- lived in the hardcoded list rather than on the role.
--
-- Stored as a KEY from `PERSPECTIVE_ICONS` (@repo/permissions), not as a
-- component name: a database must not hold a reference into a UI library,
-- or swapping the icon set leaves a column pointing at nothing.
ALTER TABLE "CustomRole" ADD COLUMN "perspectiveIcon" TEXT;

-- The four the app shipped with. Keyed on `key`, never on `name` — a name
-- is a label the operator may change, and matching on it would re-icon a
-- role somebody renamed to "Admin" for their own reasons.
UPDATE "CustomRole" SET "perspectiveIcon" = 'graduation-cap' WHERE "key" = 'seedlings.trainee';
UPDATE "CustomRole" SET "perspectiveIcon" = 'user'           WHERE "key" = 'seedlings.worker';
UPDATE "CustomRole" SET "perspectiveIcon" = 'shield-check'   WHERE "key" = 'seedlings.admin';
UPDATE "CustomRole" SET "perspectiveIcon" = 'shield'         WHERE "key" = 'seedlings.super';
