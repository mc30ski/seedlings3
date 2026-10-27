-- Admin's perspective icon: a person with a badge, not a second shield.
--
-- 20261022120000_perspective_icon backfilled Admin as `shield-check`
-- because it was the nearest key on the list at the time. On screen that
-- put a shield on Admin and a shield on Super, one row apart, and the two
-- lenses stopped being distinguishable at a glance — which is the whole
-- job of the icon. The icon set that shipped before the roles refactor
-- drew Admin as a person with a badge, so `user-cog` was added to
-- PERSPECTIVE_ICONS and Admin points at it.
--
-- Keyed, not id'd: the starter roles carry an immutable `key` precisely so
-- a correction like this can find them in any database. A role an operator
-- has since given their own icon is NOT touched — this only moves rows
-- still sitting on the value the backfill chose.
UPDATE "CustomRole"
   SET "perspectiveIcon" = 'user-cog'
 WHERE "key" = 'seedlings.admin'
   AND "perspectiveIcon" = 'shield-check';
