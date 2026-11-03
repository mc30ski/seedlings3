"use client";

/**
 * THE TIMING BAND — what a crew must know BEFORE they set off.
 *
 * An instruction is read on site: gate codes, bag the clippings, watch for
 * the dog. A timing constraint is read before leaving — "before 11", "not
 * 1–3, the baby is asleep". A crew that discovers one on arrival has
 * already wasted the drive, so it is banded across the top of the job card
 * at EVERY density rather than sitting in the body with the notes.
 *
 * WHY A BAND AND NOT A CHIP. On a phone the ultra row has no spare width —
 * the property name is already truncating there before anything is added.
 * A chip is not a worse option at that size, it is an impossible one. A
 * band is the only treatment that cannot be squeezed out by a long name.
 *
 * WHY IT BORROWS THE CARD'S OWN HUE. Every fixed colour collided with
 * something: near-black with the Expired pill, orange with the completed
 * check circle beneath it, teal with the in-progress tint, amber with the
 * yellow event card. A band in the card's own palette introduces no new
 * colour, so there is nothing left to collide with — and what makes it
 * recognisable is its SHAPE, which is constant even though its colour is
 * not. A card with no hue of its own — a completed job, an ordinary
 * scheduled visit — takes `gray`, which is that card's own shade a step
 * darker. The first version took teal there instead, and a colourless card
 * wearing a teal band looked like it was trying to say something. The
 * palette is decided ONCE, beside the card's own fill, from the same
 * `cardColorBase`; a caller that re-derives it will drift from the card.
 *
 * WHY `emphasized` + `fg` AND NOT `solid` + `contrast`. Measured across
 * all six palettes in all fourteen themes: `.contrast` is fixed per
 * palette, so it cannot compensate for a theme that moves `.solid`, and
 * green came out at 3.74:1 and red at 3.30:1 in EVERY theme — both below
 * 4.5, and both on cards you see constantly (in progress, follow-up).
 * `.emphasized` + `.fg` clears 4.5 on all 84 combinations, worst case
 * 4.81. The 2px `.solid` rule buys back the edge that fill was providing,
 * without touching the text.
 */

import { Box, HStack, Text } from "@chakra-ui/react";
import { Clock, Repeat } from "lucide-react";

export type TimingEntry = {
  text: string;
  /** EVERY_VISIT is standing; THIS_VISIT and NEXT_VISIT_ONLY are one-offs. */
  scope: string;
};

/**
 * Order and join what the band says.
 *
 * THE ONE-OFF LEADS. A standing constraint is already known to anyone who
 * works this property; "before 11 today" is the new fact, so it is read
 * first. Joined into ONE band rather than stacked: two bands would double
 * the card's height at every density, which is the cost the whole design
 * exists to avoid.
 *
 * NEVER TRUNCATED. Each entry is capped at 50 characters by the server, so
 * a pair at full length wraps to a second line instead of losing the words
 * that say when a crew may arrive. Height is cheap on the exception case.
 */
export function timingText(entries: readonly TimingEntry[]): string {
  const oneOff = entries.filter((e) => e.scope !== "EVERY_VISIT");
  const standing = entries.filter((e) => e.scope === "EVERY_VISIT");
  return [...oneOff, ...standing].map((e) => e.text).join(" · ");
}

export default function TimingBand({
  entries,
  palette,
}: {
  entries: readonly TimingEntry[];
  /** The card's own palette, from the SAME expression that fills the card
   *  — `yellow` for unassigned, `red` for a follow-up, and so on. `gray`
   *  for a card with no hue to borrow. Never re-derive it here. */
  palette: string;
}) {
  if (entries.length === 0) return null;
  const repeats = entries.some((e) => e.scope === "EVERY_VISIT");
  return (
    <HStack
      bg={`${palette}.emphasized`}
      color={`${palette}.fg`}
      borderBottomWidth="2px"
      borderColor={`${palette}.solid`}
      px={2.5}
      py="3px"
      gap={1.5}
      align="start"
      data-testid="timing-band"
    >
      {/* Centred on the first line, not the block, so a wrapped band keeps
          the glyph beside the words it belongs to. */}
      <Box h="15px" display="flex" alignItems="center" flexShrink={0}>
        <Clock size={11} />
      </Box>
      <Text fontSize="2xs" fontWeight="bold" lineHeight="short" flex="1" minW={0}>
        {timingText(entries)}
      </Text>
      {repeats && (
        <Box h="15px" display="flex" alignItems="center" flexShrink={0} title="Applies to every visit">
          <Repeat size={10} />
        </Box>
      )}
    </HStack>
  );
}
