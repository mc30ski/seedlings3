"use client";

// Inline section for the Tasks page — lists every completed STANDARD /
// ONE_OFF occurrence whose hours haven't been approved for payroll
// (`hoursApprovedAt = null`). Each row shows the variance between
// estimate and actual time so the operator can decide at a glance
// whether to approve as-is. Adjustments to the recorded time still
// route through the JobsTab "Review Hours" dialog via Goto Task —
// same scope pattern as PendingWorkdaysSection.
//
// Approve hits the same /approve-hours endpoint the JobsTab row
// button uses, so the audit trail + downstream payroll-export
// filtering line up identically with the existing flow.

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { CheckCircle2 } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Assignee = {
  userId: string;
  user: {
    displayName: string | null;
    email: string | null;
    workerType: string | null;
  };
};

type UnapprovedHoursRow = {
  id: string;
  title: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalPausedMs: number;
  estimatedMinutes: number | null;
  job: {
    id: string;
    property: {
      displayName: string | null;
      client: { displayName: string | null } | null;
    } | null;
  } | null;
  assignees: Assignee[];
};

function workerLabel(a: Assignee): string {
  return a.user.displayName || a.user.email || a.userId.slice(-6);
}

function jobTitle(row: UnapprovedHoursRow): string {
  if (row.title) return row.title;
  return row.job?.property?.displayName ?? "Untitled occurrence";
}

function clientName(row: UnapprovedHoursRow): string | null {
  return row.job?.property?.client?.displayName ?? null;
}

// Actual active minutes = (completedAt - startedAt) - totalPausedMs.
// Returns null when the row is missing endpoints (shouldn't happen
// given the server filter, but defensive against future shape drift).
function actualMinutes(row: UnapprovedHoursRow): number | null {
  if (!row.startedAt || !row.completedAt) return null;
  const ms = Date.parse(row.completedAt) - Date.parse(row.startedAt) - (row.totalPausedMs ?? 0);
  return Math.max(0, Math.round(ms / 60_000));
}

function variancePercent(row: UnapprovedHoursRow): number | null {
  const actual = actualMinutes(row);
  const est = row.estimatedMinutes;
  if (!actual || !est) return null;
  return Math.round(((actual - est) / est) * 100);
}

function fmtMinutes(min: number | null | undefined): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function variancePalette(pct: number | null): string {
  if (pct == null) return "gray";
  if (Math.abs(pct) <= 30) return "gray";
  return pct > 0 ? "red" : "orange";
}

export default function UnapprovedHoursSection() {
  const [rows, setRows] = useState<UnapprovedHoursRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<UnapprovedHoursRow[]>("/api/admin/occurrences/unapproved-hours");
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load unapproved hours.", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("seedlings3:jobs-changed", onChanged);
    return () => window.removeEventListener("seedlings3:jobs-changed", onChanged);
  }, [load]);

  async function approve(row: UnapprovedHoursRow) {
    setBusyId(row.id);
    try {
      await apiPost(`/api/admin/occurrences/${row.id}/approve-hours`, {});
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
      publishInlineMessage({ type: "SUCCESS", text: "Hours approved for payroll." });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to approve hours.", err),
      });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && rows.length === 0) {
    return (
      <HStack py={3} justify="center" color="fg.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Loading…</Text>
      </HStack>
    );
  }
  if (rows.length === 0) return null;

  return (
    <VStack align="stretch" gap={2}>
      {rows.map((r) => {
        const actual = actualMinutes(r);
        const pct = variancePercent(r);
        const client = clientName(r);
        const workers = r.assignees.map(workerLabel).join(", ") || "(no assignees)";
        return (
          <Box
            key={r.id}
            p={2}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
          >
            <HStack justify="space-between" align="start" gap={2} wrap="wrap">
              <VStack align="start" gap={0.5} flex={1} minW={0}>
                <HStack gap={2} wrap="wrap">
                  <Text fontSize="sm" fontWeight="medium">
                    {jobTitle(r)}
                    {client && (
                      <Text as="span" color="fg.muted" fontWeight="normal">
                        {" · "}{client}
                      </Text>
                    )}
                  </Text>
                </HStack>
                <Text fontSize="2xs" color="fg.muted">
                  {workers} · Completed {r.completedAt ? fmtDate(r.completedAt) : "—"}
                </Text>
                <HStack gap={2} mt={0.5}>
                  <Text fontSize="2xs" color="fg.muted">
                    Est <b>{fmtMinutes(r.estimatedMinutes)}</b> · Actual <b>{fmtMinutes(actual)}</b>
                  </Text>
                  {pct != null && (
                    <Badge
                      size="xs"
                      colorPalette={variancePalette(pct)}
                      variant={Math.abs(pct) > 30 ? "solid" : "subtle"}
                    >
                      {pct >= 0 ? "+" : ""}{pct}% vs estimate
                    </Badge>
                  )}
                </HStack>
              </VStack>
              <Button
                size="xs"
                colorPalette="green"
                disabled={busyId !== null}
                onClick={() => void approve(r)}
              >
                <CheckCircle2 size={12} /> Approve
              </Button>
            </HStack>
          </Box>
        );
      })}
    </VStack>
  );
}
