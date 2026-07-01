"use client";

// Inline section for the Tasks page — fetches every pending workday
// across the dates that currently have any (pulled from the existing
// pending-summary endpoint), then displays a flat list with an inline
// Approve button per row. The approval endpoint is the same one
// WorkdaysTab's Review dialog uses on confirm; we just skip the
// Review dialog when the operator wants to approve with the recorded
// times as-is. Anything that needs editing still routes through the
// full Review dialog via the Goto Task button on the parent
// CollapsibleSectionCard.

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Car, CheckCircle2 } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDateOpts, fmtTimeOpts } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import StatusChip from "@/src/ui/components/StatusChip";

type SuperWorkdayRow = {
  id: string;
  userId: string;
  workdayDate: string;
  startedAt: string;
  endedAt: string | null;
  pausedAt: string | null;
  totalPausedMs: number;
  approvedAt: string | null;
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
    workerType: string | null;
  };
  uiState: "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "APPROVED";
  isOpen: boolean;
  adminWindowOpen: boolean;
};

type ByDateResponse = {
  workdayDate: string;
  adminWindowOpen: boolean;
  rows: SuperWorkdayRow[];
};

// Mileage entry as returned by /super/mileage/by-date. Same shape the
// WorkdaysTab consumes so the two surfaces render mileage identically.
type MileageEntry = {
  id: string;
  vehicleId: string;
  vehicleName: string;
  startedAt: string;
  endedAt: string | null;
  startOdometer: number;
  endOdometer: number | null;
  miles: number | null;
  notes: string | null;
  approvedAt: string | null;
};

type MileageByDateResponse = Record<string, MileageEntry[]>;

function workerLabel(u: SuperWorkdayRow["user"]): string {
  return u.displayName || u.email || u.id.slice(-8);
}

function activeMs(row: SuperWorkdayRow, now = Date.now()): number {
  const start = Date.parse(row.startedAt);
  const end = row.endedAt ? Date.parse(row.endedAt) : now;
  return Math.max(0, end - start - (row.totalPausedMs ?? 0));
}

function fmtHours(ms: number): string {
  const hours = ms / 3_600_000;
  return `${hours.toFixed(1)}h`;
}

export default function PendingWorkdaysSection() {
  const [rows, setRows] = useState<SuperWorkdayRow[]>([]);
  // Mileage entries keyed by `${userId}:${entryDate}` — inline sub-row
  // on each workday for the two-button approval model. Only entries
  // for dates that also have a pending workday show up; mileage-only
  // days live on the Vehicles tab (a known trade-off — see the design
  // discussion in project docs).
  const [mileageByRow, setMileageByRow] = useState<Record<string, MileageEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Loads pending rows across every date that has any pending workdays
  // — uses the existing pending-summary endpoint to learn which dates
  // to fetch, then fetches each in parallel. Typical pending-summary
  // returns 1-3 dates so the parallel fan-out stays cheap. Mileage is
  // fetched alongside so each row can render its per-worker sessions
  // inline.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await apiGet<{
        totalPending: number;
        byDate: { workdayDate: string; count: number }[];
      }>("/api/super/workdays/pending-summary");
      const dates = Array.isArray(summary?.byDate) ? summary.byDate : [];
      if (dates.length === 0) {
        setRows([]);
        setMileageByRow({});
        return;
      }
      const [pages, mileagePages] = await Promise.all([
        Promise.all(
          dates.map((d) =>
            apiGet<ByDateResponse>(`/api/super/workdays/by-date?date=${d.workdayDate}`).catch(() => null),
          ),
        ),
        Promise.all(
          dates.map((d) =>
            apiGet<MileageByDateResponse>(`/api/super/mileage/by-date?date=${d.workdayDate}`).catch(() => null),
          ),
        ),
      ]);
      const pendingAcrossDates: SuperWorkdayRow[] = [];
      for (const page of pages) {
        if (!page) continue;
        for (const r of page.rows) {
          // COMPLETED + not yet approved = pending approval. The
          // pending-summary counts IN_PROGRESS / NEEDS_ENDING
          // separately (those go to Needs Ending, not here).
          if (r.uiState === "COMPLETED") pendingAcrossDates.push(r);
        }
      }
      // Oldest-first so the operator works through the backlog from
      // the oldest date — same ordering convention WorkdaysTab uses.
      pendingAcrossDates.sort((a, b) => a.workdayDate.localeCompare(b.workdayDate));
      setRows(pendingAcrossDates);
      // Fold mileage pages into the `${userId}:${entryDate}` map.
      const mileage: Record<string, MileageEntry[]> = {};
      dates.forEach((d, i) => {
        const page = mileagePages[i];
        if (!page) return;
        for (const [userId, entries] of Object.entries(page)) {
          mileage[`${userId}:${d.workdayDate}`] = entries;
        }
      });
      setMileageByRow(mileage);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load pending workdays.", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function approveRow(row: SuperWorkdayRow) {
    setBusyId(row.id);
    try {
      // Empty body — Approve with the recorded times as-is. Any edit
      // path still routes through WorkdaysTab's Review dialog (the
      // Goto Task button on the parent CollapsibleSectionCard).
      await apiPost(`/api/super/workdays/${row.id}/approve`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Workday approved." });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approve failed.", err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function approveMileage(row: SuperWorkdayRow) {
    // Approves every closed unapproved entry the driver logged that
    // day. Anything already approved stays untouched. Open sessions
    // are excluded server-side.
    const key = `mileage:${row.id}`;
    setBusyId(key);
    try {
      await apiPost(`/api/super/mileage/approve-day`, {
        userId: row.userId,
        entryDate: row.workdayDate,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Mileage approved." });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approve failed.", err),
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
        const active = activeMs(r);
        const mileageEntries = mileageByRow[`${r.userId}:${r.workdayDate}`] ?? [];
        const pendingMileage = mileageEntries.filter(
          (e) => e.endedAt != null && e.approvedAt == null,
        );
        const totalMiles = mileageEntries.reduce((s, e) => s + (e.miles ?? 0), 0);
        return (
          <Box
            key={r.id}
            p={2}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
          >
            <HStack justify="space-between" align="start" gap={2} wrap="wrap">
              <VStack align="start" gap={0} flex={1} minW={0}>
                <HStack gap={2}>
                  <Text fontSize="sm" fontWeight="medium">{workerLabel(r.user)}</Text>
                  {r.user.workerType && (
                    <Badge size="xs" variant="outline">{r.user.workerType}</Badge>
                  )}
                  <StatusChip
                    open={r.uiState === "IN_PROGRESS" || r.uiState === "PAUSED"}
                    approved={r.uiState === "APPROVED"}
                  />
                </HStack>
                <Text fontSize="2xs" color="fg.muted">
                  {fmtDateOpts(`${r.workdayDate}T12:00:00Z`, { month: "short", day: "numeric", year: "numeric" })}
                  {" · "}
                  {fmtTimeOpts(r.startedAt, { hour: "numeric", minute: "2-digit" })}
                  {" – "}
                  {r.endedAt ? fmtTimeOpts(r.endedAt, { hour: "numeric", minute: "2-digit" }) : "(open)"}
                  {" · "}
                  {fmtHours(active)} active
                </Text>
              </VStack>
              <Button
                size="xs"
                colorPalette="green"
                disabled={busyId !== null}
                onClick={() => void approveRow(r)}
              >
                <CheckCircle2 size={12} /> Approve hours
              </Button>
            </HStack>
            {/* Mileage sub-row — visible only when this driver has any
                mileage entries for the same date. Two-button approval:
                hours (above) and mileage (below) fire independently
                against their own endpoints. Editing an entry is done
                on the Vehicles tab. */}
            {mileageEntries.length > 0 && (
              <HStack
                justify="space-between"
                align="start"
                gap={2}
                wrap="wrap"
                mt={2}
                pt={2}
                borderTopWidth="1px"
                borderColor="gray.100"
              >
                <HStack gap={2} align="start" flex={1} minW={0}>
                  <Box color="fg.muted" mt={0.5}>
                    <Car size={12} />
                  </Box>
                  <VStack align="start" gap={0} flex={1} minW={0}>
                    <Text fontSize="xs">
                      {mileageEntries.length} session{mileageEntries.length === 1 ? "" : "s"}
                      {" · "}
                      {totalMiles.toLocaleString()} mi
                      {pendingMileage.length > 0 && (
                        <Text as="span" color="orange.700" fontWeight="medium">
                          {" · "}{pendingMileage.length} pending
                        </Text>
                      )}
                    </Text>
                    <HStack gap={2}>
                      <Text fontSize="2xs" color="fg.muted" lineClamp={1}>
                        {mileageEntries.map((e) => e.vehicleName).join(", ")}
                      </Text>
                      <StatusChip
                        open={mileageEntries.some((e) => e.endedAt == null)}
                        approved={
                          mileageEntries.length > 0 &&
                          mileageEntries.every((e) => e.endedAt != null && e.approvedAt != null)
                        }
                      />
                    </HStack>
                  </VStack>
                </HStack>
                {pendingMileage.length > 0 && (
                  <Button
                    size="xs"
                    colorPalette="green"
                    disabled={busyId !== null}
                    onClick={() => void approveMileage(r)}
                  >
                    <CheckCircle2 size={12} /> Approve mileage
                  </Button>
                )}
              </HStack>
            )}
          </Box>
        );
      })}
    </VStack>
  );
}
