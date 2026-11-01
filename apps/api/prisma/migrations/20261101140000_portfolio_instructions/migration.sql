-- What belongs in a portfolio, in the operator's own words.
--
-- A filing rule rather than a description: the tier says what KIND of
-- level a node is, this says which properties go in THIS one. Optional,
-- free text, enforced by nothing — a property can still be filed
-- anywhere. It exists so the rule does not live only in one person's
-- head.
ALTER TABLE "Portfolio" ADD COLUMN "instructions" TEXT;
