"use client";

// Inline Tasks-page section for repeating-service pauses whose
// reminder date has arrived or passed. Each row shows client, property,
// stream label, reason, and reminder date. The "Review" button navigates
// to the Services tab where the operator can Resume / Edit / Extend.
//
// Fetches from /api/admin/stream-pauses/reminders — same endpoint
// that populates the alert badge count. Bus event
// `seedlings:stream-pauses-changed` keeps the list in sync when
// pauses are updated from ServicesTab.

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { ArrowUpRight } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type DueRow = {
  id: string;
  title: string | null;
  jobType: string | null;
  streamPausedAt: string | null;
  streamPauseReason: string | null;
  streamResumeReminderAt: string | null;
  job: {
    id: string;
    description: string | null;
    property: {
      displayName: string;
      client: { id: string; displayName: string };
    } | null;
  } | null;
};

export default function RepeatingPausesDueSection({
  onReview,
}: {
  /** Called with the paused occurrence's id when the operator clicks
   *  "Review". Parent typically closes the Tasks page and navigates
   *  to the Services tab where the paused card lives. */
  onReview: (occurrenceId: string) => void;
}) {
  const [items, setItems] = useState<DueRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiGet<DueRow[]>("/api/admin/stream-pauses/reminders");
      setItems(Array.isArray(rows) ? rows : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load paused repeating list.", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("seedlings:stream-pauses-changed", onChanged);
    return () => window.removeEventListener("seedlings:stream-pauses-changed", onChanged);
  }, [load]);

  if (loading && items.length === 0) {
    return (
      <HStack py={3} justify="center" color="fg.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Loading…</Text>
      </HStack>
    );
  }
  if (items.length === 0) return null;

  return (
    <VStack align="stretch" gap={2}>
      {items.map((row) => {
        const clientName = row.job?.property?.client?.displayName ?? "—";
        const propertyName = row.job?.property?.displayName ?? null;
        const streamLabel = row.jobType ?? row.title ?? "repeating service";
        return (
          <Box
            key={row.id}
            p={3}
            borderWidth="1px"
            borderColor="purple.200"
            bg="purple.50"
            borderRadius="md"
          >
            <HStack justify="space-between" align="start" gap={2}>
              <VStack align="start" gap={0.5} flex={1} minW={0}>
                <HStack gap={1.5} flexWrap="wrap">
                  <Text fontSize="sm" fontWeight="semibold">
                    {clientName}
                    {propertyName ? ` — ${propertyName}` : ""}
                  </Text>
                  <Badge colorPalette="purple" variant="subtle" fontSize="2xs">
                    {streamLabel}
                  </Badge>
                </HStack>
                <Text fontSize="xs" color="purple.800">
                  {row.streamPausedAt && (<>Paused {fmtDate(row.streamPausedAt)}</>)}
                  {row.streamResumeReminderAt && (
                    <> · reminder {fmtDate(row.streamResumeReminderAt)}</>
                  )}
                </Text>
                {row.streamPauseReason && (
                  <Text fontSize="xs" color="purple.900" fontStyle="italic">
                    "{row.streamPauseReason}"
                  </Text>
                )}
              </VStack>
              <Button
                size="xs"
                colorPalette="purple"
                onClick={() => onReview(row.id)}
                title="Open this paused service in the Services tab"
                flexShrink={0}
              >
                Review <ArrowUpRight size={12} style={{ marginLeft: 3 }} />
              </Button>
            </HStack>
          </Box>
        );
      })}
    </VStack>
  );
}
