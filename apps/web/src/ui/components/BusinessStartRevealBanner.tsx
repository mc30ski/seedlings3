"use client";

import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { Eye } from "lucide-react";
import { useBusinessStartCutoff } from "@/src/lib/businessStartCutoff";

/**
 * Sticky top-of-page banner shown whenever the Super "Reveal pre-cutoff
 * history" override is engaged.
 *
 * Why this exists: the reveal toggle changes what every Money/Jobs/Stats
 * surface returns, which is easy to forget once you've drilled into a
 * specific tab. The banner gives the operator a persistent reminder that
 * they're looking at unfiltered data (including pre-cutoff legacy rows)
 * and a one-click "Turn off" affordance so they don't have to navigate
 * back to Settings → BSD just to flip it.
 *
 * Renders nothing when reveal is OFF — zero visual cost in the default
 * state. Self-dismisses on page reload (the override itself is
 * session-only; see lib/businessStartCutoff.tsx).
 */
export default function BusinessStartRevealBanner() {
  const { reveal, setReveal } = useBusinessStartCutoff();
  if (!reveal) return null;
  return (
    <Box
      position="sticky"
      top={0}
      left={0}
      right={0}
      zIndex={9999}
      bg="purple.600"
      color="white"
      px={3}
      py={1.5}
      borderBottomWidth="1px"
      borderColor="purple.800"
      shadow="md"
    >
      <HStack gap={2} justify="space-between" align="center" wrap="wrap">
        <HStack gap={2} align="center" flex="1" minW={0}>
          <Eye size={14} />
          <Text fontSize="xs" fontWeight="semibold" lineHeight="1.3">
            Reveal pre-cutoff history is ON — viewing unfiltered data (session only)
          </Text>
        </HStack>
        <Button
          size="xs"
          variant="outline"
          colorPalette="purple"
          onClick={() => setReveal(false)}
          flexShrink={0}
          css={{
            background: "white",
            color: "var(--chakra-colors-purple-800)",
            borderColor: "white",
            _hover: { background: "var(--chakra-colors-purple-50)" },
          }}
        >
          Turn off
        </Button>
      </HStack>
    </Box>
  );
}
