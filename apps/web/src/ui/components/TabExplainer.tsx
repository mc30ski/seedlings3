"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The collapsed "what is this tab" disclosure.
//
// Standing copy that answers a question you ask once and then know. Open by
// default it held the top of every visit to the page — on a phone it pushed
// the actual content off the first screen entirely.
//
// EXTRACTED AFTER THE THIRD COPY. Supplies, Pricing and Promotions each had
// their own paste of this markup, and they had already begun to drift (one
// said "Show"/"Hide" where the others used a chevron, one used blue.300 for
// its border). A fourth and fifth copy were about to be written for the rest
// of Money.
//
// WRITE THE COPY FROM THE CODE, NOT FROM MEMORY. Explanatory text that
// disagrees with behaviour is worse than none, because it reads as
// documentation — a help string on the Supplies tab described a ledger link
// the UI had no control for, and it read as a shipped feature for weeks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { usePersistedState } from "@/src/lib/usePersistedState";

export default function TabExplainer({
  storageKey,
  title,
  children,
}: {
  /** Per-tab, per-role where the copy differs by role — so collapsing it as a
   *  worker does not also collapse the different text an admin sees.
   *  Convention: "seedlings:<tab>Tab:guideOpen" (plus a role suffix). */
  storageKey: string;
  /** Short. It is the whole affordance when collapsed, which is most of the
   *  time — "How supplies are tracked", not a sentence. */
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistedState<boolean>(storageKey, false);
  return (
    <Box borderWidth="1px" borderColor="blue.200" borderRadius="md" overflow="hidden">
      <HStack
        as="button"
        w="full"
        px={2}
        py={1.5}
        gap={2}
        bg="blue.50"
        cursor="pointer"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {/* The icon carries "explanatory, not a warning" — the blue fill alone
            was doing that work and reads the same as an alert to anyone who
            has not learned the convention. */}
        <Box color="blue.700" flexShrink={0} display="flex" alignItems="center">
          <Info size={14} />
        </Box>
        <Text fontSize="xs" color="blue.800" fontWeight="semibold" flex="1" textAlign="left">
          {title}
        </Text>
        {/* A chevron says it opens. "Show"/"Hide" as the only affordance reads
            as a link to somewhere else. */}
        <Box color="blue.700" flexShrink={0} display="flex" alignItems="center">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </Box>
      </HStack>
      {open && (
        <Box px={2} py={2} bg="blue.50" borderTopWidth="1px" borderColor="blue.200">
          <VStack align="stretch" gap={1.5}>
            {children}
          </VStack>
        </Box>
      )}
    </Box>
  );
}

/** A paragraph inside a TabExplainer. Exists so callers do not each re-declare
 *  the size and colour — three copies of this markup had already drifted. */
export function ExplainerText({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="xs" color="blue.800">
      {children}
    </Text>
  );
}

/** Emphasis inside explainer copy. */
export function Em({ children }: { children: ReactNode }) {
  return (
    <Text as="span" fontWeight="semibold">
      {children}
    </Text>
  );
}
