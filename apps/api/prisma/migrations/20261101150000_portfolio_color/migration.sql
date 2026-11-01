-- The colour a portfolio is drawn in, on the map and in the list.
--
-- A Chakra PALETTE NAME ("green", "orange"), never a hex: a literal would
-- be the same colour in all fourteen themes, and the map already resolves
-- `--chakra-colors-<palette>-solid` off the document at render time.
--
-- NULL means AUTO rather than "no colour" — an unset portfolio is still
-- drawn, taking a palette from its position in the tree, so ten zones are
-- distinguishable before anybody has chosen ten colours.
ALTER TABLE "Portfolio" ADD COLUMN "color" TEXT;
