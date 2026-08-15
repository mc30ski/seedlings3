-- Add per-row opt-in for the app's startup typing animation. When the
-- app cold-starts (new tab, PWA launch, browser restart) it shows the
-- logo + a typing animation that cycles through vanity URL slugs. This
-- flag controls which rows are included; when no row is checked the
-- app just shows the logo without any animation.

ALTER TABLE "VanityPage"
  ADD COLUMN "showInStartupAnimation" BOOLEAN NOT NULL DEFAULT false;
