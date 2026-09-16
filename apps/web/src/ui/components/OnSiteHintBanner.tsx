"use client";

import { Box, HStack, Spinner, Text } from "@chakra-ui/react";
import type { OnSiteHint } from "@/src/lib/onSiteHint";

/**
 * Compact callout shown inside the start/complete-occurrence dialogs to
 * explain WHY the default button changed. Renders whether we're still
 * resolving location, know we're near, know we're far, or can't detect
 * at all — so the user always sees a rationale for the current default
 * choice.
 *
 * Styled blue-informational for every state EXCEPT `unknown-user`, which
 * is a yellow warning: location access is off or unreliable and no GPS
 * will ever get stamped on the job until the user does something about it.
 */
export default function OnSiteHintBanner({ hint }: { hint: OnSiteHint }) {
  const isWarning = hint.mode === "unknown-user";
  const bg = isWarning ? "yellow.faint" : "blue.faint";
  const borderColor = isWarning ? "yellow.emphasized" : "blue.emphasized";
  const borderLeftColor = isWarning ? "yellow.500" : "blue.500";
  const fg = isWarning ? "yellow.fg" : "blue.fg";

  if (hint.mode === "loading") {
    return (
      <Box
        p={3}
        bg={bg}
        borderWidth="1px"
        borderColor={borderColor}
        borderLeftWidth="4px"
        borderLeftColor={borderLeftColor}
        rounded="md"
      >
        <HStack gap={2} align="center">
          <Spinner size="xs" />
          <Text fontSize="sm" color={fg}>{hint.message}</Text>
        </HStack>
      </Box>
    );
  }

  return (
    <Box
      p={3}
      bg={bg}
      borderWidth="1px"
      borderColor={borderColor}
      borderLeftWidth="4px"
      borderLeftColor={borderLeftColor}
      rounded="md"
    >
      <Text fontSize="sm" color={fg}>{hint.message}</Text>
    </Box>
  );
}
