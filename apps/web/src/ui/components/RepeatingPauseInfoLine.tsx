"use client";

// Purple callout that surfaces the pause context (when it started,
// when to check back, why) for a repeating-service pause. Rendered
// as a distinct panel below the occurrence's chip row so the paused
// state can't be missed at a glance — the small chip alone isn't
// enough visual weight for "this isn't going to happen."
//
// Renders nothing when the occurrence isn't repeating-paused, so
// callers can drop it in unconditionally without a null check.

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { PauseCircle } from "lucide-react";
import { fmtDate } from "@/src/lib/dates";

type Occ = {
  status?: string | null;
  streamPausedAt?: string | null;
  streamResumeReminderAt?: string | null;
  streamPauseReason?: string | null;
  /** Taxonomy key. Rows paused before the taxonomy existed have none. */
  streamPauseReasonCode?: string | null;
};

/** Label for a reason code, from the taxonomy the caller already loaded.
 *  Falls back to the raw code so an unknown or retired key still renders
 *  something, rather than the reason silently vanishing from the card. */
function labelFor(code: string | null | undefined, reasons: { code: string; label: string }[]) {
  if (!code) return null;
  return reasons.find((r) => r.code === code)?.label ?? code;
}

export default function RepeatingPauseInfoLine({
  occ,
  reasons = [],
}: {
  occ: Occ;
  /** The pause-reason taxonomy. Optional so existing callers keep working;
   *  without it the coded reason renders as its raw key. */
  reasons?: { code: string; label: string }[];
}) {
  const isPaused =
    (occ.status as string | null | undefined) === "STREAM_PAUSED" ||
    !!occ.streamPausedAt;
  if (!isPaused) return null;

  return (
    <Box
      bg="purple.faint"
      borderWidth="1px"
      borderColor="purple.emphasized"
      borderLeftWidth="4px"
      borderLeftColor="purple.500"
      borderRadius="md"
      p={3}
      mt={2}
    >
      <HStack align="start" gap={2}>
        <Box color="purple.fg" flexShrink={0} mt={0.5}>
          <PauseCircle size={18} />
        </Box>
        <VStack align="start" gap={1} flex={1} minW={0}>
          <Text fontSize="sm" fontWeight="semibold" color="purple.fg" lineHeight="1.2">
            Repeating service paused
          </Text>
          {(occ.streamPausedAt || occ.streamResumeReminderAt) && (
            <Text fontSize="xs" color="purple.fg" lineHeight="1.3">
              {occ.streamPausedAt && (
                <>Paused <b>{fmtDate(occ.streamPausedAt)}</b></>
              )}
              {occ.streamPausedAt && occ.streamResumeReminderAt && " · "}
              {occ.streamResumeReminderAt && (
                <>Reminder to resume by <b>{fmtDate(occ.streamResumeReminderAt)}</b></>
              )}
            </Text>
          )}
          {/* THE CODED REASON FIRST. It is the categorical answer — what the
              filters and counts are built on — and it reads as a label, not a
              sentence. The operator's note follows as the detail. */}
          {labelFor(occ.streamPauseReasonCode, reasons) && (
            <Text fontSize="xs" fontWeight="semibold" color="purple.fg" lineHeight="1.3">
              {labelFor(occ.streamPauseReasonCode, reasons)}
            </Text>
          )}
          {occ.streamPauseReason && (
            <Text
              fontSize="xs"
              color="purple.fg"
              fontStyle="italic"
              lineHeight="1.4"
            >
              "{occ.streamPauseReason}"
            </Text>
          )}
        </VStack>
      </HStack>
    </Box>
  );
}
