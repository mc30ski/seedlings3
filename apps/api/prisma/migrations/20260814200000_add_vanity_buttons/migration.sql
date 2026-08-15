-- Vanity pages: replace the single ctaText/ctaUrl pair with a JSON
-- array of buttons. Each button carries a kind (URL / PHONE / EMAIL),
-- a label, and a target. Editor + renderer expand tel:/mailto: prefixes
-- from the target at read time.
--
-- Backward compat: the legacy ctaText/ctaUrl columns are RETAINED so a
-- production row that predates this migration keeps rendering. The
-- public API synthesizes a single URL button from those when buttons is
-- NULL; the editor migrates them into the buttons array on next save.

ALTER TABLE "VanityPage" ADD COLUMN "buttons" JSONB;
