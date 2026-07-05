"use client";

// Compact one-liner that surfaces the pause context (when it started,
// when to check back, why) for a repeating-service pause.
//
// Renders nothing when the occurrence isn't repeating-paused OR when
// none of the fields are populated — so callers can drop it in
// unconditionally without a null check.
//
// Layout:  Paused {date} · resume by {date} · "{reason}"
// Each segment is optional and hides gracefully when its data is null.

import { Text } from "@chakra-ui/react";
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

  const parts: string[] = [];
  if (occ.streamPausedAt) parts.push(`Paused ${fmtDate(occ.streamPausedAt)}`);
  if (occ.streamResumeReminderAt) {
    parts.push(`resume by ${fmtDate(occ.streamResumeReminderAt)}`);
  }
  if (occ.streamPauseReason) parts.push(`"${occ.streamPauseReason}"`);

  if (parts.length === 0) return null;

  return (
    <Text
      fontSize="xs"
      color="purple.700"
      mt={1}
      lineHeight="1.3"
    >
      {parts.join(" · ")}
    </Text>
  );
}
