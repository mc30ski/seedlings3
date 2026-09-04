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

/** Filled, not tinted. A severe-weather advisory competing with a job-count
 *  chip for attention should win — these were a pale wash that read as
 *  decoration. White on red/orange, black on yellow, because a solid yellow
 *  chip with white text is unreadable. */
const onTone = (tone: string) => (tone === "yellow" ? "black" : "white");

export function WeatherAlertBadge({
  alerts,
  density = "compact",
  max = 2,
  expandable = false,
  openId = null,
  onToggle,
}: {
  alerts: WeatherAlert[] | undefined;
  density?: Density;
  max?: number;
  /** Turns each compact chip into a disclosure — a filled triangle, matching
   *  the ▶/▼ the day-section headers already use. The body itself is rendered
   *  by the CALLER via <WeatherAlertDetail>. */
  expandable?: boolean;
  /** CONTROLLED, deliberately. These chips live inside a day-section header,
   *  which is a horizontal flex row; a panel emitted from in here became a
   *  flex sibling and shoved the date, the count and the Route chip off their
   *  line. The caller owns the open id so it can put the body BELOW the
   *  header, where a full-width block belongs. */
  openId?: string | null;
  onToggle?: (id: string) => void;
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
        color={`${alertTone(a)}.solid`}
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
          const tone = alertTone(a);
          const open = openId === a.id;
          return (
            <HStack
              key={a.id}
              {...(expandable
                ? {
                    as: "button" as const,
                    type: "button" as const,
                    // The header this sits in is itself clickable on some
                    // surfaces; without this, expanding an advisory also
                    // collapses the day.
                    onClick: (e: any) => {
                      // The day-section header this sits in toggles the whole
                      // day on click. Without this, opening an advisory also
                      // collapses the section it just appeared under.
                      e.stopPropagation();
                      onToggle?.(a.id);
                    },
                    "aria-expanded": open,
                    "aria-label": `${a.event} — ${open ? "hide" : "show"} details`,
                    cursor: "pointer",
                  }
                : { title: a.headline })}
              gap={1}
              px={1.5}
              py={0.5}
              align="center"
              lineHeight="1"
              borderRadius="full"
              bg={`${tone}.solid`}
              borderWidth="1px"
              borderColor={`${tone}.solid`}
              _hover={expandable ? { filter: "brightness(1.08)" } : undefined}
            >
              <Box as="span" color={onTone(tone)} display="inline-flex">
                <Icon size={12} />
              </Box>
              <Text
                fontSize="11px"
                fontWeight="bold"
                lineHeight="1"
                color={onTone(tone)}
                whiteSpace="nowrap"
              >
                {shortLabel(a)}
              </Text>
              {expandable && (
                <Text as="span" fontSize="9px" lineHeight="1" color={onTone(tone)}
                      opacity={0.9}>
                  {open ? "\u25BC" : "\u25B6"}
                </Text>
              )}
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
        const tone = alertTone(a);
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

/**
 * The expanded body for ONE alert, rendered by the CALLER.
 *
 * It lives out here rather than inside the badge because the chip sits in a
 * horizontal header row — a panel emitted from in there became a flex sibling
 * of the date and the job count and pushed them off their line. The caller
 * drops this below the header, where a full-width block belongs.
 */
export function WeatherAlertDetail({ alert }: { alert: WeatherAlert }) {
  const tone = alertTone(alert);
  const Icon = alertIcon(alert.kind);
  return (
    <Box px={2.5} py={2} mb={2} borderRadius="md" bg={`${tone}.subtle`}
         borderWidth="1px" borderLeftWidth="3px" borderColor={`${tone}.solid`}>
      <HStack gap={2} align="start">
        <Box as="span" color={`${tone}.solid`} mt="2px" flexShrink={0} display="inline-flex">
          <Icon size={16} />
        </Box>
        <Box minW={0}>
          <Text fontSize="13px" fontWeight="semibold">
            {alert.event}
            <Text as="span" fontWeight="normal" color="fg.muted">
              {" "}· {whenLabel(alert, bizToday(), bizTomorrow())}
            </Text>
          </Text>
          <Text fontSize="12px" color="fg.muted">{alert.headline}</Text>
          {alert.instruction && <Text fontSize="12px" mt={1}>{alert.instruction}</Text>}
        </Box>
      </HStack>
    </Box>
  );
}
