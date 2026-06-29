"use client";

// Inline section for the Tasks page — lists past-due TimelineEvents
// (the same rows that count as "urgent" in the title-bar Timeline
// alert badge). Mark-complete is super-only at the API layer
// (services/timelineEvents.ts), so the inline Complete button only
// renders for super. Admin-without-super sees the list as
// informational and uses Goto Task to act in the Timeline tab.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { CheckCircle2 } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDateOpts } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type UpcomingRow = {
  // listUpcoming returns rows that may be either an event or a
  // document_expiration. Only events have a complete action — doc
  // expirations are read-only proxies for an underlying document.
  kind?: "event" | "document_expiration";
  id?: string;
  documentId?: string;
  title: string;
  description?: string | null;
  category?: string | null;
  rrule?: string | null;
  type?: string;
  nextDate: string | null;
  archivedAt?: string | null;
  adminHidden?: boolean;
};

function isPast(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

type Props = {
  // Complete is super-only at the API; admin-without-super gets a
  // read-only list. Passed in from TasksPage so we don't re-derive
  // the role here.
  isSuper: boolean;
};

export default function TimelineUrgentSection({ isSuper }: Props) {
  const [rows, setRows] = useState<UpcomingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = isSuper
        ? "/api/super/timeline/upcoming"
        : "/api/admin/timeline/upcoming";
      const list = await apiGet<UpcomingRow[]>(endpoint);
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load timeline events.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [isSuper]);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("seedlings3:timeline-changed", onChanged);
    return () => window.removeEventListener("seedlings3:timeline-changed", onChanged);
  }, [load]);

  // Past-due only — matches the "urgent" bucket the title-bar badge
  // uses (see services/timelineEvents.ts upcomingCounts).
  const overdue = useMemo(
    () => rows.filter((r) => isPast(r.nextDate)),
    [rows],
  );

  async function complete(row: UpcomingRow) {
    if (row.kind === "document_expiration" || !row.id) return;
    setBusyId(row.id);
    try {
      await apiPost(`/api/super/timeline/${row.id}/complete`, {});
      window.dispatchEvent(new Event("seedlings3:timeline-changed"));
      publishInlineMessage({ type: "SUCCESS", text: "Marked complete." });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Mark complete failed.", err),
      });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && overdue.length === 0) {
    return (
      <HStack py={3} justify="center" color="fg.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Loading…</Text>
      </HStack>
    );
  }
  if (overdue.length === 0) return null;

  return (
    <VStack align="stretch" gap={2}>
      {overdue.map((r) => {
        const rowKey = r.id ?? r.documentId ?? r.title;
        const canComplete = isSuper && r.kind !== "document_expiration" && !!r.id;
        return (
          <Box
            key={rowKey}
            p={2}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
          >
            <HStack justify="space-between" align="start" gap={2} wrap="wrap">
              <VStack align="start" gap={0.5} flex={1} minW={0}>
                <HStack gap={2}>
                  <Text fontSize="sm" fontWeight="medium">{r.title}</Text>
                  {r.kind === "document_expiration" && (
                    <Badge size="xs" variant="outline">Document</Badge>
                  )}
                  {r.category && (
                    <Badge size="xs" colorPalette="indigo" variant="subtle">{r.category}</Badge>
                  )}
                </HStack>
                <Text fontSize="2xs" color="fg.muted">
                  Due {r.nextDate ? fmtDateOpts(r.nextDate, { month: "short", day: "numeric", year: "numeric" }) : "—"}
                </Text>
              </VStack>
              {canComplete && (
                <Button
                  size="xs"
                  colorPalette="green"
                  disabled={busyId !== null}
                  onClick={() => void complete(r)}
                >
                  <CheckCircle2 size={12} /> Complete
                </Button>
              )}
            </HStack>
          </Box>
        );
      })}
    </VStack>
  );
}
