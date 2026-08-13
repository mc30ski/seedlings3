-- Change Promotion.landingPage FK onDelete from SetNull to Restrict.
-- Prevents the ghost-state class of bug where a landing-page DELETE
-- nulls Promotion.landingPageId but leaves linkKind='LANDING_PAGE',
-- causing resolveDestinationUrl to return null and clicks to 302
-- to the bare baseUrl. Under Restrict, the DELETE fails loudly if a
-- Promotion still references the landing page — the caller must first
-- flip linkKind back to EXTERNAL (and null landingPageId) in the same
-- transaction, keeping audit-observable state consistent.

ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_landingPageId_fkey";
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_landingPageId_fkey"
  FOREIGN KEY ("landingPageId") REFERENCES "PromotionLandingPage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
