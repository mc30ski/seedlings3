"use client";

// One badge, three densities — so the title bar, the weather bar and a
// section header all show the same alert with the same colour and icon
// without each call site re-deriving it.
//
// Renders nothing when there is no alert. Every consumer can mount it
// unconditionally; an empty alerts array is the normal case.

import { Box, HStack, Text } from "@chakra-ui/react";
import {
  alertIcon, alertTone, shortLabel, topAlert, whenLabel,
  type WeatherAlert,
} from "@/src/lib/weatherAlerts";
import { bizToday, bizTomorrow } from "@/src/lib/dates";

/** `icon` — glyph only, for the title bar where space is a few pixels.
 *  `compact` — glyph + short label, for the weather bar and section headers.
 *  `full` — glyph + event name + when it ends + what to do. */
type Density = "icon" | "compact" | "full";

export function WeatherAlertBadge({
  alerts,
  density = "compact",
  max = 2,
}: {
  alerts: WeatherAlert[] | undefined;
  density?: Density;
  max?: number;
}) {
  if (!alerts?.length) return null;

  if (density === "icon") {
    const today = bizToday();
    const top = topAlert(alerts, today)!;
    const a = top.alert;
    const Icon = alertIcon(a.kind);
    const when = whenLabel(a, today, bizTomorrow());
    // An alert in force NOW is solid; one that starts later is outlined and
    // dimmed, so it never reads as "this is happening right now" while the
    // date-scoped surfaces below correctly show nothing for today.
    return (
      <Box
        as="span"
        title={`${a.event} — ${when}${alerts.length > 1 ? ` (+${alerts.length - 1} more)` : ""}`}
        color={`${alertTone(a.severity)}.solid`}
        opacity={top.today ? 1 : 0.55}
        display="inline-flex"
        alignItems="center"
        aria-label={`${a.event} ${when}`}
      >
        <Icon size={14} />
      </Box>
    );
  }

  const shown = [...alerts].slice(0, max);

  if (density === "compact") {
    return (
      <HStack gap={1} flexWrap="wrap" align="center" flexShrink={0}>
        {shown.map((a) => {
          const Icon = alertIcon(a.kind);
          const tone = alertTone(a.severity);
          return (
            <HStack
              key={a.id}
              gap={1}
              px={1.5}
              py={0.5}
              align="center"
              lineHeight="1"
              borderRadius="full"
              bg={`${tone}.subtle`}
              borderWidth="1px"
              borderColor={`${tone}.solid`}
              title={a.headline}
            >
              <Box as="span" color={`${tone}.solid`} display="inline-flex">
                <Icon size={12} />
              </Box>
              <Text
                fontSize="11px"
                fontWeight="semibold"
                lineHeight="1"
                color={`${tone}.fg`}
                whiteSpace="nowrap"
              >
                {shortLabel(a)}
              </Text>
            </HStack>
          );
        })}
        {alerts.length > shown.length && (
          <Text fontSize="11px" color="fg.muted">+{alerts.length - shown.length}</Text>
        )}
      </HStack>
    );
  }

  return (
    <Box display="flex" flexDirection="column" gap={1.5} w="full">
      {shown.map((a) => {
        const Icon = alertIcon(a.kind);
        const tone = alertTone(a.severity);
        return (
          <HStack
            key={a.id}
            gap={2}
            align="start"
            px={2.5}
            py={2}
            borderRadius="md"
            bg={`${tone}.subtle`}
            borderWidth="1px"
            borderLeftWidth="3px"
            borderColor={`${tone}.solid`}
          >
            <Box as="span" color={`${tone}.solid`} mt="1px" flexShrink={0}>
              <Icon size={16} />
            </Box>
            <Box minW={0}>
              <Text fontSize="13px" fontWeight="semibold">{a.event}</Text>
              <Text fontSize="12px" color="fg.muted">{a.headline}</Text>
              {a.instruction && (
                <Text fontSize="12px" mt={1}>{a.instruction}</Text>
              )}
            </Box>
          </HStack>
        );
      })}
    </Box>
  );
}
