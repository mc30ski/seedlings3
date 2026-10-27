-- Admin's perspective icon, corrected a second time: a person holding a
-- KEY, which is the icon that actually shipped before the roles refactor
-- (`GrUserAdmin`, react-icons/gr).
--
-- 20261022180000 moved Admin off `shield-check` and onto `user-cog` on the
-- reasoning that lucide's person-with-a-gear was the nearest thing to it.
-- It is not: side by side with the original they are different pictures,
-- and the point of restoring the old set is that operators recognise it.
-- So `user-key` was added to PERSPECTIVE_ICONS drawing the original
-- component, and Admin points there. `user-cog` stays on the list — it is
-- a perfectly good glyph, just not this one.
--
-- Keyed, and conditional on the value the previous migration wrote, so a
-- role an operator has since given an icon of their own is left alone.
UPDATE "CustomRole"
   SET "perspectiveIcon" = 'user-key'
 WHERE "key" = 'seedlings.admin'
   AND "perspectiveIcon" = 'user-cog';
