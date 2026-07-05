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
import { fmtDate } from "@/src/lib/lib";

type Occ = {
  status?: string | null;
  streamPausedAt?: string | null;
  streamResumeReminderAt?: string | null;
  streamPauseReason?: string | null;
};

export default function RepeatingPauseInfoLine({ occ }: { occ: Occ }) {
  const isPaused =
    (occ.status as string | null | undefined) === "STREAM_PAUSED" ||
    !!occ.streamPausedAt;
  if (!isPaused) return null;

  return (
    <Box
      bg="purple.50"
      borderWidth="1px"
      borderColor="purple.300"
      borderLeftWidth="4px"
      borderLeftColor="purple.500"
      borderRadius="md"
      p={3}
      mt={2}
    >
      <HStack align="start" gap={2}>
        <Box color="purple.600" flexShrink={0} mt={0.5}>
          <PauseCircle size={18} />
        </Box>
        <VStack align="start" gap={1} flex={1} minW={0}>
          <Text fontSize="sm" fontWeight="semibold" color="purple.900" lineHeight="1.2">
            Repeating service paused
          </Text>
          {(occ.streamPausedAt || occ.streamResumeReminderAt) && (
            <Text fontSize="xs" color="purple.800" lineHeight="1.3">
              {occ.streamPausedAt && (
                <>Paused <b>{fmtDate(occ.streamPausedAt)}</b></>
              )}
              {occ.streamPausedAt && occ.streamResumeReminderAt && " · "}
              {occ.streamResumeReminderAt && (
                <>Reminder to resume by <b>{fmtDate(occ.streamResumeReminderAt)}</b></>
              )}
            </Text>
          )}
          {occ.streamPauseReason && (
            <Text
              fontSize="xs"
              color="purple.900"
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
