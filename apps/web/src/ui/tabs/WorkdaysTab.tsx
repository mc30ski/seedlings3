"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Car, ChevronLeft, ChevronRight, AlertTriangle, Edit3, RotateCcw } from "lucide-react";
import StatusChip from "@/src/ui/components/StatusChip";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import MileageReviewDialog, { type MileageReviewEntry } from "@/src/ui/dialogs/MileageReviewDialog";
import {
  bizToday,
  bizAddDays,
  bizToLocalInputValue,
  bizParseLocalInputValue,
  bizInstantFromEtParts,
  fmtTimeOpts,
  fmtDateOpts,
} from "@/src/lib/lib";

// ─────────────────────────────────────────────────────────────────────────
// Super → Workdays — day-paged review surface.
//
// Pulls /api/super/workdays/by-date?date=YYYY-MM-DD and groups the result
// into APPROVED / PENDING APPROVAL / NEEDS ENDING / DIDN'T WORK sections.
// Each row has a Review button that opens the unified ReviewDialog (edit
// times + approve / unapprove). Bulk approve sits at the bottom of the
// pending bucket.
//
// The 4 AM rule (settings-driven) is enforced server-side; this UI reads
// `adminWindowOpen` from the response and switches into a "same-day
// approval" mode when false — actions are still allowed but the operator
// has to clear a typed double-confirm before the request goes out (and
// the server stamps `sameDayBypass: true` in the audit log). Same-day
// approval is risky because the worker's edit window is still open; if
// they discover a missed pause after we lock in the times, the row's
// already approved and they're stuck.
// ─────────────────────────────────────────────────────────────────────────

type WorkerLite = {
  id: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
};

type SuperWorkdayRow = {
  id: string;
  userId: string;
  workdayDate: string;
  startedAt: string;
  endedAt: string | null;
  pausedAt: string | null;
  totalPausedMs: number;
  approvedAt: string | null;
  user: WorkerLite;
  approvedBy: { id: string; displayName: string | null; email: string | null } | null;
  uiState: "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "APPROVED";
  isOpen: boolean;
  adminWindowOpen: boolean;
  /** Projected earnings for the worker on THIS workday date. Same
   *  math the operations dashboard uses; server-computed so the row
   *  can show a $/hr chip once approved. */
  netEarnedOnDate: number;
  /** Effective $/hr for the day. Null when the row had no active
   *  minutes (still open, or a closed row with zero worked time). */
  hourlyRateOnDate: number | null;
};

type DidntWorkUser = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
};

type WorkdaysByDateResponse = {
  workdayDate: string;
  adminWindowOpen: boolean;
  rows: SuperWorkdayRow[];
  didntWork: DidntWorkUser[];
};

// One mileage session as returned by /super/mileage/by-date. Response
// is a map keyed by driverUserId → entries[]. Sessions are surfaced
// inline on each WorkdayRow with an Approve-mileage button that fires
// independently of the workday-hours approval.
type WorkdaysTabMileageEntry = {
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

function workerLabel(u: { displayName: string | null; email: string | null }): string {
  return u.displayName ?? u.email ?? "(unnamed)";
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function activeMs(row: SuperWorkdayRow, now: number = Date.now()): number {
  const start = Date.parse(row.startedAt);
  const end = row.endedAt ? Date.parse(row.endedAt) : now;
  let paused = row.totalPausedMs;
  if (row.pausedAt && !row.endedAt) {
    paused += Math.max(0, now - Date.parse(row.pausedAt));
  }
  return Math.max(0, end - start - paused);
}

/**
 * Optional props let pages/index.tsx drive cross-tab navigation from the
 * Super alert badge:
 *
 *   pendingByDate       — per-day pending counts for the chip row above
 *                         the day picker. Sorted oldest → newest.
 *   initialDate         — when set, the tab jumps to this day. Bumped
 *                         via `jumpNonce` so repeat badge clicks re-fire
 *                         even if the operator is already inside the tab.
 *   jumpNonce           — counter that triggers the jump effect.
 *   onApprovalsChanged  — fires after any approve / bulk-approve /
 *                         unapprove so the parent can refresh its badge
 *                         count without a separate polling pass.
 */
type WorkdaysTabProps = {
  pendingByDate?: { workdayDate: string; count: number }[];
  initialDate?: string | null;
  jumpNonce?: number;
  onApprovalsChanged?: () => void;
};

export default function WorkdaysTab({
  pendingByDate = [],
  initialDate = null,
  jumpNonce = 0,
  onApprovalsChanged,
}: WorkdaysTabProps = {}) {
  const [selectedDate, setSelectedDate] = useState(
    () => initialDate || bizAddDays(bizToday(), -1),
  );
  const [data, setData] = useState<WorkdaysByDateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewRow, setReviewRow] = useState<SuperWorkdayRow | null>(null);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  // Backfill dialog state — Super clicks "Add workday" in the Didn't
  // Work section to create a row for a worker who forgot to clock in.
  const [createForUser, setCreateForUser] = useState<DidntWorkUser | null>(null);
  // Mileage entries for the selected date, keyed by driverUserId. Each
  // WorkdayRow drills into this map to render its mileage sub-row +
  // Approve-mileage button. Fetched in parallel with the workdays
  // payload in load() below.
  const [mileageByUser, setMileageByUser] = useState<Record<string, WorkdaysTabMileageEntry[]>>({});
  const [busyMileageId, setBusyMileageId] = useState<string | null>(null);
  // Per-worker × date mileage review dialog. Opens from the mileage
  // sub-row's Review button; the caller passes the driver label + all
  // that day's entries. Same lifecycle as WorkdaysTab.ReviewDialog for
  // workday hours: edit fields → Save changes → Approve / Unapprove.
  const [reviewMileageFor, setReviewMileageFor] = useState<{
    driverUserId: string;
    driverLabel: string;
    entryDate: string;
    entries: MileageReviewEntry[];
  } | null>(null);

  // Whenever the mileage map refreshes (post-save reload), re-sync the
  // open dialog's entries so its badges + inputs reflect fresh state.
  useEffect(() => {
    if (!reviewMileageFor) return;
    const fresh = mileageByUser[reviewMileageFor.driverUserId] ?? [];
    // Snap to the same identity check to avoid the setState-loops
    // React runs when the array reference doesn't change.
    if (fresh === reviewMileageFor.entries) return;
    setReviewMileageFor((prev) => (prev ? { ...prev, entries: fresh } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mileageByUser]);

  // External jump from the alert badge. Re-runs each time the parent
  // bumps the nonce, so repeat clicks always re-route even if the user
  // had navigated to a different day.
  useEffect(() => {
    if (initialDate) setSelectedDate(initialDate);
    // jumpNonce is the trigger; initialDate is the payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpNonce]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Two parallel fetches — workdays and per-user mileage entries
      // for the same date. Mileage endpoint returns {} when nobody
      // drove that day.
      const [r, mileage] = await Promise.all([
        apiGet<WorkdaysByDateResponse>(`/api/super/workdays/by-date?date=${selectedDate}`),
        apiGet<Record<string, WorkdaysTabMileageEntry[]>>(
          `/api/super/mileage/by-date?date=${selectedDate}`,
        ).catch(() => ({} as Record<string, WorkdaysTabMileageEntry[]>)),
      ]);
      setData(r);
      setMileageByUser(mileage ?? {});
      // Clear selection on day change — selected ids only make sense within one day.
      setBulkSelected(new Set());
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load workdays.", err) });
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  async function approveMileageForRow(row: SuperWorkdayRow) {
    setBusyMileageId(row.id);
    try {
      await apiPost(`/api/super/mileage/approve-day`, {
        userId: row.userId,
        entryDate: row.workdayDate,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Mileage approved." });
      await load();
      onApprovalsChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approve failed.", err),
      });
    } finally {
      setBusyMileageId(null);
    }
  }


  useEffect(() => {
    void load();
  }, [load]);

  // Bucket the rows for rendering. Sorting is server-side; we just split.
  const grouped = useMemo(() => {
    const approved: SuperWorkdayRow[] = [];
    const pending: SuperWorkdayRow[] = [];
    const needsEnding: SuperWorkdayRow[] = [];
    const liveToday: SuperWorkdayRow[] = []; // today's IN_PROGRESS / PAUSED
    if (!data) return { approved, pending, needsEnding, liveToday };
    for (const r of data.rows) {
      if (r.uiState === "APPROVED") approved.push(r);
      else if (r.uiState === "COMPLETED") pending.push(r);
      else if (r.uiState === "IN_PROGRESS" || r.uiState === "PAUSED") {
        // If the day's already past, this is "needs ending" (forgot to end).
        // If today, it's just "currently working."
        if (data.adminWindowOpen) needsEnding.push(r);
        else liveToday.push(r);
      }
    }
    return { approved, pending, needsEnding, liveToday };
  }, [data]);

  const headerLabel = useMemo(() => {
    return fmtDateOpts(`${selectedDate}T12:00:00Z`, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, [selectedDate]);

  function dayShift(delta: number) {
    setSelectedDate(bizAddDays(selectedDate, delta));
  }

  // Bulk-select uses prefixed keys so hours and mileage share one Set
  // without special-casing at every callsite:
  //   • `w:<workdayId>`               → the workday's hours row
  //   • `m:<userId>:<entryDate>`      → all pending mileage entries
  //                                     for that worker × ET date
  // The Select-all master and Approve-N-selected button count them
  // together; runBulkApprove splits them back into their respective
  // endpoints.
  const workdayBulkKey = (workdayId: string) => `w:${workdayId}`;
  const mileageBulkKey = (userId: string, entryDate: string) =>
    `m:${userId}:${entryDate}`;

  function toggleBulk(id: string) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Full set of bulk-selectable keys in the pending section — every
  // pending workday plus every worker × date that has ≥1 pending
  // mileage session in that row.
  const bulkEligibleKeys = useMemo(() => {
    const keys: string[] = [];
    for (const r of grouped.pending) {
      keys.push(workdayBulkKey(r.id));
      const sessions = mileageByUser[r.userId] ?? [];
      const hasPending = sessions.some(
        (e) => e.endedAt != null && e.approvedAt == null,
      );
      if (hasPending) keys.push(mileageBulkKey(r.userId, r.workdayDate));
    }
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped.pending, mileageByUser]);

  function toggleBulkAll() {
    if (bulkSelected.size === bulkEligibleKeys.length) {
      setBulkSelected(new Set());
    } else {
      setBulkSelected(new Set(bulkEligibleKeys));
    }
  }

  async function runBulkApprove() {
    setBulkConfirmOpen(false);
    // Split the unified selection into its two categories. Only what
    // the operator explicitly ticked gets approved — no implicit
    // cascade from workday → mileage (that would defeat the whole
    // two-button model).
    const workdayIds: string[] = [];
    const mileageTargets: Array<{ userId: string; entryDate: string }> = [];
    for (const key of bulkSelected) {
      if (key.startsWith("w:")) {
        workdayIds.push(key.slice(2));
      } else if (key.startsWith("m:")) {
        const rest = key.slice(2);
        const idx = rest.lastIndexOf(":");
        if (idx > 0) {
          mileageTargets.push({
            userId: rest.slice(0, idx),
            entryDate: rest.slice(idx + 1),
          });
        }
      }
    }
    try {
      // Fire both endpoint sets in parallel.
      const [wdRes, mlRes] = await Promise.all([
        workdayIds.length > 0
          ? apiPost<{
              approved: string[];
              alreadyApproved: string[];
              failed: { id: string; reason: string }[];
            }>("/api/super/workdays/bulk-approve", {
              workdayIds,
              allowSameDay: !!data && !data.adminWindowOpen,
            })
          : Promise.resolve({ approved: [], alreadyApproved: [], failed: [] }),
        Promise.allSettled(
          mileageTargets.map((t) =>
            apiPost(`/api/super/mileage/approve-day`, {
              userId: t.userId,
              entryDate: t.entryDate,
            }),
          ),
        ),
      ]);
      const wdApproved = wdRes.approved.length;
      const wdAlready = wdRes.alreadyApproved.length;
      const wdFailed = wdRes.failed.length;
      const mlApproved = mlRes.filter((r) => r.status === "fulfilled").length;
      const mlFailed = mlRes.filter((r) => r.status === "rejected").length;

      const parts: string[] = [];
      if (workdayIds.length > 0) {
        parts.push(
          `${wdApproved} workday${wdApproved === 1 ? "" : "s"} approved` +
            (wdAlready ? `, ${wdAlready} already approved` : "") +
            (wdFailed ? `, ${wdFailed} failed` : ""),
        );
      }
      if (mileageTargets.length > 0) {
        parts.push(
          `${mlApproved} mileage bundle${mlApproved === 1 ? "" : "s"} approved` +
            (mlFailed ? `, ${mlFailed} failed` : ""),
        );
      }
      publishInlineMessage({
        type: wdFailed + mlFailed === 0 ? "SUCCESS" : "WARNING",
        text: parts.join(" · "),
      });
      if (wdFailed > 0) {
        for (const f of wdRes.failed) {
          publishInlineMessage({ type: "ERROR", text: `Workday ${f.id}: ${f.reason}` });
        }
      }
      setBulkSelected(new Set());
      void load();
      onApprovalsChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Bulk approve failed.", err) });
    }
  }

  // Sanity stats for the bulk-confirm dialog — workday count, total
  // active hours, count of "outliers" outside 4–10 hours, and mileage
  // bundle count (surfaced so the confirm dialog can say "3 workdays
  // + 2 mileage bundles" instead of a bare "5 items").
  const bulkStats = useMemo(() => {
    const wdRows = grouped.pending.filter((r) =>
      bulkSelected.has(workdayBulkKey(r.id)),
    );
    let totalMs = 0;
    let outliers = 0;
    for (const r of wdRows) {
      const ms = activeMs(r);
      totalMs += ms;
      const hours = ms / 3600000;
      if (hours < 4 || hours > 10) outliers += 1;
    }
    const mileageCount = Array.from(bulkSelected).filter((k) =>
      k.startsWith("m:"),
    ).length;
    return {
      count: wdRows.length,
      totalHours: totalMs / 3600000,
      outliers,
      mileageCount,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped.pending, bulkSelected]);

  return (
    <VStack align="stretch" gap={3}>
      {/* Pending-by-day chip row — only renders when there's a backlog.
          Each chip is a one-click jump to that day; the active chip
          highlights so Super can tell at a glance where they are. The
          parent (pages/index.tsx) supplies the counts and refreshes
          them via onApprovalsChanged after every mutation. */}
      {pendingByDate.length > 0 && (
        <Card.Root variant="outline" bg="indigo.50" borderColor="indigo.200">
          <Card.Body p={3}>
            <HStack gap={2} align="center" wrap="wrap">
              <Text fontSize="xs" fontWeight="semibold" color="indigo.900">
                Pending:
              </Text>
              {pendingByDate.map((d) => {
                const isActive = d.workdayDate === selectedDate;
                return (
                  <Button
                    key={d.workdayDate}
                    size="xs"
                    variant={isActive ? "solid" : "outline"}
                    colorPalette="purple"
                    onClick={() => setSelectedDate(d.workdayDate)}
                  >
                    {fmtDateOpts(`${d.workdayDate}T12:00:00Z`, { month: "short", day: "numeric" })} ({d.count})
                  </Button>
                );
              })}
              <Text fontSize="xs" color="indigo.700" ml={1}>
                {pendingByDate.reduce((s, d) => s + d.count, 0)} total
              </Text>
            </HStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* Day picker row */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <HStack gap={2} align="center" wrap="wrap">
            <Box flex="1" minW="220px">
              <Text fontSize="sm" fontWeight="semibold">{headerLabel}</Text>
              {data && (
                <Text fontSize="xs" color="fg.muted">
                  {data.rows.length} workday{data.rows.length === 1 ? "" : "s"} ·{" "}
                  {grouped.approved.length} approved · {grouped.pending.length} pending
                  {grouped.needsEnding.length > 0 && ` · ${grouped.needsEnding.length} needs ending`}
                  {data.didntWork.length > 0 && ` · ${data.didntWork.length} didn't work`}
                  {!data.adminWindowOpen && " · same-day approval (risky)"}
                </Text>
              )}
            </Box>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              max={bizToday()}
              style={{
                padding: "4px 8px",
                fontSize: "13px",
                border: "1px solid var(--chakra-colors-gray-200)",
                borderRadius: "6px",
              }}
            />
            {/* Keep the prev / today / next buttons together as one
                wrappable unit — otherwise on narrow viewports the last
                button gets shoved onto its own row, separated from
                Today and Previous. The inner HStack's wrap="nowrap"
                pins them together; the outer row wraps the group as
                a whole. */}
            <HStack gap={1} wrap="nowrap" flexShrink={0}>
              <Button size="sm" variant="outline" onClick={() => dayShift(-1)} title="Previous day">
                <ChevronLeft size={16} />
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelectedDate(bizToday())}>
                Today
              </Button>
              <Button size="sm" variant="outline" onClick={() => dayShift(1)} title="Next day" disabled={selectedDate >= bizToday()}>
                <ChevronRight size={16} />
              </Button>
            </HStack>
          </HStack>
          {!data?.adminWindowOpen && (
            <Box mt={2} p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
              <HStack gap={2} align="start">
                <AlertTriangle size={14} color="var(--chakra-colors-orange-700)" style={{ marginTop: 2 }} />
                <Text fontSize="xs" color="orange.900">
                  <strong>Same-day approval is risky.</strong> The approval window
                  normally opens at the configured cutoff (default 4 AM ET the next
                  morning) so workers have time to fix things they noticed after
                  clocking out (a missed pause, a wrong end time). Approving now
                  closes that door — any correction the worker discovers later will
                  be locked behind an unapprove. Only approve same-day if you're
                  certain the workday is final.
                </Text>
              </HStack>
            </Box>
          )}
        </Card.Body>
      </Card.Root>

      {loading && !data ? (
        <HStack justify="center" py={8}><Spinner /></HStack>
      ) : !data ? null : (
        <>
          {/* NEEDS ENDING — surfaced first because these are blockers. */}
          {grouped.needsEnding.length > 0 && (
            <SectionCard title="Needs ending" color="orange" count={grouped.needsEnding.length}>
              {grouped.needsEnding.map((r) => (
                <WorkdayRow
                  key={r.id}
                  row={r}
                  onReview={() => setReviewRow(r)}
                  mileageEntries={mileageByUser[r.userId]}
                  onApproveMileage={() => void approveMileageForRow(r)}
                  onReviewMileage={() => {
                    const entries = mileageByUser[r.userId] ?? [];
                    setReviewMileageFor({
                      driverUserId: r.userId,
                      driverLabel: workerLabel(r.user),
                      entryDate: r.workdayDate,
                      entries,
                    });
                  }}
                  mileageBusy={busyMileageId === r.id}
                />
              ))}
            </SectionCard>
          )}

          {/* PENDING APPROVAL — with bulk approve. */}
          {grouped.pending.length > 0 && (
            <SectionCard title="Pending approval" color="blue" count={grouped.pending.length}>
              <HStack mb={2} gap={2}>
                <Checkbox.Root
                  checked={
                    bulkEligibleKeys.length > 0 &&
                    bulkSelected.size === bulkEligibleKeys.length
                  }
                  onCheckedChange={() => toggleBulkAll()}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontSize="xs">Select all pending</Checkbox.Label>
                </Checkbox.Root>
                {bulkSelected.size > 0 && (
                  <Button
                    size="sm"
                    colorPalette="green"
                    onClick={() => setBulkConfirmOpen(true)}
                  >
                    Approve {bulkSelected.size} selected
                  </Button>
                )}
              </HStack>
              {grouped.pending.map((r) => (
                <WorkdayRow
                  key={r.id}
                  row={r}
                  onReview={() => setReviewRow(r)}
                  mileageEntries={mileageByUser[r.userId]}
                  onApproveMileage={() => void approveMileageForRow(r)}
                  onReviewMileage={() => {
                    const entries = mileageByUser[r.userId] ?? [];
                    setReviewMileageFor({
                      driverUserId: r.userId,
                      driverLabel: workerLabel(r.user),
                      entryDate: r.workdayDate,
                      entries,
                    });
                  }}
                  mileageBusy={busyMileageId === r.id}
                  checkbox
                  checked={bulkSelected.has(workdayBulkKey(r.id))}
                  onToggle={() => toggleBulk(workdayBulkKey(r.id))}
                  mileageChecked={bulkSelected.has(mileageBulkKey(r.userId, r.workdayDate))}
                  onToggleMileage={() => toggleBulk(mileageBulkKey(r.userId, r.workdayDate))}
                />
              ))}
            </SectionCard>
          )}

          {/* LIVE TODAY — for today's view only. */}
          {grouped.liveToday.length > 0 && (
            <SectionCard title="Currently working" color="green" count={grouped.liveToday.length}>
              {grouped.liveToday.map((r) => (
                <WorkdayRow
                  key={r.id}
                  row={r}
                  onReview={() => setReviewRow(r)}
                  mileageEntries={mileageByUser[r.userId]}
                  onApproveMileage={() => void approveMileageForRow(r)}
                  onReviewMileage={() => {
                    const entries = mileageByUser[r.userId] ?? [];
                    setReviewMileageFor({
                      driverUserId: r.userId,
                      driverLabel: workerLabel(r.user),
                      entryDate: r.workdayDate,
                      entries,
                    });
                  }}
                  mileageBusy={busyMileageId === r.id}
                />
              ))}
            </SectionCard>
          )}

          {/* APPROVED — recap. */}
          {grouped.approved.length > 0 && (
            <SectionCard title="Approved" color="gray" count={grouped.approved.length}>
              {grouped.approved.map((r) => (
                <WorkdayRow
                  key={r.id}
                  row={r}
                  onReview={() => setReviewRow(r)}
                  mileageEntries={mileageByUser[r.userId]}
                  onApproveMileage={() => void approveMileageForRow(r)}
                  onReviewMileage={() => {
                    const entries = mileageByUser[r.userId] ?? [];
                    setReviewMileageFor({
                      driverUserId: r.userId,
                      driverLabel: workerLabel(r.user),
                      entryDate: r.workdayDate,
                      entries,
                    });
                  }}
                  mileageBusy={busyMileageId === r.id}
                />
              ))}
            </SectionCard>
          )}

          {/* DIDN'T WORK — short list of workers without a row, restricted
              to users with ≥1 workday in history (server enforces).
              Each row gets an "Add workday" affordance so Super can
              backfill a row for a worker who forgot to clock in.

              Also surfaces mileage sessions on this date for drivers
              who logged mileage without clocking a workday (e.g., the
              driver was an Observer on the job — didn't do the work
              but ran the truck). Without this, a lone pending mileage
              entry is invisible in the UI even though it drives the
              "Workdays / mileage to review" alert count. */}
          {data.didntWork.length > 0 && (
            <SectionCard title="Didn't work" color="gray" count={data.didntWork.length} muted>
              <VStack align="stretch" gap={0}>
                {data.didntWork.map((u) => {
                  const sessions = mileageByUser[u.userId] ?? [];
                  const pendingSessions = sessions.filter(
                    (e) => e.endedAt != null && e.approvedAt == null,
                  );
                  const totalMiles = sessions.reduce((s, e) => s + (e.miles ?? 0), 0);
                  return (
                    <VStack key={u.userId} align="stretch" gap={1} py={1}>
                      <HStack fontSize="sm" color="fg.muted">
                        <Text flex="1">{workerLabel(u)}</Text>
                        {u.workerType && <Badge size="xs" variant="outline">{u.workerType}</Badge>}
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setCreateForUser(u)}
                        >
                          Add workday
                        </Button>
                      </HStack>
                      {sessions.length > 0 && (
                        <HStack
                          justify="space-between"
                          align="start"
                          gap={2}
                          wrap="wrap"
                          pl={2}
                        >
                          <HStack gap={2} align="start" flex={1} minW={0}>
                            <Box color="fg.muted" mt={0.5}>
                              <Car size={12} />
                            </Box>
                            <VStack align="start" gap={0} flex={1} minW={0}>
                              <HStack gap={2}>
                                <Text fontSize="xs">
                                  {sessions.length} session{sessions.length === 1 ? "" : "s"}
                                  {" · "}
                                  {totalMiles.toLocaleString()} mi
                                  {pendingSessions.length > 0 && (
                                    <Text as="span" color="orange.700" fontWeight="medium">
                                      {" · "}{pendingSessions.length} pending
                                    </Text>
                                  )}
                                </Text>
                                <StatusChip
                                  open={sessions.some((s) => s.endedAt == null)}
                                  approved={
                                    sessions.length > 0 &&
                                    sessions.every((s) => s.endedAt != null && s.approvedAt != null)
                                  }
                                />
                              </HStack>
                              <Text fontSize="2xs" color="fg.muted" lineClamp={1}>
                                {sessions.map((e) => e.vehicleName).join(", ")}
                              </Text>
                            </VStack>
                          </HStack>
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="blue"
                            onClick={() => {
                              setReviewMileageFor({
                                driverUserId: u.userId,
                                driverLabel: workerLabel(u),
                                entryDate: selectedDate,
                                entries: sessions,
                              });
                            }}
                          >
                            Review
                          </Button>
                        </HStack>
                      )}
                    </VStack>
                  );
                })}
              </VStack>
            </SectionCard>
          )}

          {data.rows.length === 0 && data.didntWork.length === 0 && (
            <Card.Root variant="outline">
              <Card.Body p={6}>
                <Text fontSize="sm" color="fg.muted" textAlign="center">
                  No workday data for this date.
                </Text>
              </Card.Body>
            </Card.Root>
          )}
        </>
      )}

      {/* Unified Review dialog — edit + approve / unapprove */}
      {reviewRow && (
        <ReviewDialog
          row={reviewRow}
          onClose={() => setReviewRow(null)}
          onAfter={() => { void load(); setReviewRow(null); onApprovalsChanged?.(); }}
        />
      )}

      {/* Mileage review dialog — mirrors the ReviewDialog lifecycle
          for the worker × date's mileage sessions. Stays open across
          per-entry mutations; the reload cascades entries back in. */}
      {reviewMileageFor && (
        <MileageReviewDialog
          driverLabel={reviewMileageFor.driverLabel}
          entryDate={reviewMileageFor.entryDate}
          entries={reviewMileageFor.entries}
          onClose={() => setReviewMileageFor(null)}
          onChanged={() => {
            void load();
            onApprovalsChanged?.();
            // Rehydrate the dialog's entries from the freshly-loaded
            // map on the next render — we hold the last-known copy in
            // state and refresh it when reload finishes.
          }}
        />
      )}

      {/* Backfill dialog — Super creates a workday for someone in the
          "Didn't work" section who forgot to clock in. */}
      {createForUser && (
        <CreateWorkdayDialog
          worker={createForUser}
          workdayDate={selectedDate}
          onClose={() => setCreateForUser(null)}
          onAfter={() => {
            void load();
            setCreateForUser(null);
            onApprovalsChanged?.();
          }}
        />
      )}

      {/* Bulk approve confirmation */}
      <BulkApproveConfirm
        open={bulkConfirmOpen}
        count={bulkStats.count}
        totalHours={bulkStats.totalHours}
        outliers={bulkStats.outliers}
        mileageCount={bulkStats.mileageCount}
        sameDay={!!data && !data.adminWindowOpen}
        onCancel={() => setBulkConfirmOpen(false)}
        onConfirm={() => void runBulkApprove()}
      />
    </VStack>
  );
}

// ── Section card ──────────────────────────────────────────────────────────

function SectionCard({
  title,
  color,
  count,
  muted,
  children,
}: {
  title: string;
  color: string;
  count: number;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card.Root variant="outline" opacity={muted ? 0.85 : 1}>
      <Card.Body p={3}>
        <HStack gap={2} mb={2}>
          <Text fontSize="sm" fontWeight="semibold">{title}</Text>
          <Badge size="sm" colorPalette={color} variant="subtle">{count}</Badge>
        </HStack>
        <VStack align="stretch" gap={1}>{children}</VStack>
      </Card.Body>
    </Card.Root>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────

function WorkdayRow({
  row,
  onReview,
  checkbox,
  checked,
  onToggle,
  mileageEntries,
  onApproveMileage,
  onReviewMileage,
  mileageBusy,
  mileageChecked,
  onToggleMileage,
}: {
  row: SuperWorkdayRow;
  onReview: () => void;
  checkbox?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  /** Mileage sessions for this worker on this date. Omitted → sub-row
   *  hidden. Empty array → also hidden (no sessions to surface). */
  mileageEntries?: WorkdaysTabMileageEntry[];
  onApproveMileage?: () => void;
  /** Opens the per-worker × date mileage review dialog. Mirrors the
   *  workday-row Review button lifecycle. */
  onReviewMileage?: () => void;
  mileageBusy?: boolean;
  /** Bulk-select checkbox for the mileage sub-row. Only rendered when
   *  the workday row is also in checkbox mode (`checkbox={true}`) AND
   *  the mileage row has ≥1 pending session. */
  mileageChecked?: boolean;
  onToggleMileage?: () => void;
}) {
  const active = activeMs(row);
  const sessions = mileageEntries ?? [];
  const pendingMileage = sessions.filter(
    (e) => e.endedAt != null && e.approvedAt == null,
  );
  const totalMiles = sessions.reduce((s, e) => s + (e.miles ?? 0), 0);
  return (
    <VStack
      align="stretch"
      p={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      gap={2}
    >
      <HStack gap={2} align="center" wrap="wrap">
        {checkbox && (
          <Checkbox.Root checked={!!checked} onCheckedChange={() => onToggle?.()}>
            <Checkbox.HiddenInput />
            <Checkbox.Control />
          </Checkbox.Root>
        )}
        <VStack align="start" gap={0} flex="1" minW="200px">
          <HStack gap={2}>
            <Text fontSize="sm" fontWeight="medium">{workerLabel(row.user)}</Text>
            {row.user.workerType && <Badge size="xs" variant="outline">{row.user.workerType}</Badge>}
            <StatusChip
              open={row.isOpen}
              approved={row.uiState === "APPROVED"}
            />
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            {fmtTimeOpts(row.startedAt, { hour: "numeric", minute: "2-digit" })}
            {" – "}
            {row.endedAt ? fmtTimeOpts(row.endedAt, { hour: "numeric", minute: "2-digit" }) : "(open)"}
            {" · "}
            {fmtDuration(active)} active
            {row.totalPausedMs > 0 && ` · ${fmtDuration(row.totalPausedMs)} paused`}
          </Text>
          {row.uiState === "APPROVED" && row.hourlyRateOnDate != null && (
            <Text
              fontSize="xs"
              color="green.700"
              fontWeight="semibold"
              title={`Projected earnings for this workday date. Same math the Operations dashboard uses.`}
            >
              ${row.hourlyRateOnDate.toFixed(2)}/hr
              <Text as="span" fontSize="2xs" color="fg.muted" fontWeight="normal" ml={1}>
                · ${row.netEarnedOnDate.toFixed(2)} earned
              </Text>
            </Text>
          )}
          {row.approvedBy && (
            <Text fontSize="2xs" color="fg.muted">
              Approved by {workerLabel(row.approvedBy)} on{" "}
              {fmtDateOpts(row.approvedAt!, { month: "short", day: "numeric" })}{" "}
              {fmtTimeOpts(row.approvedAt!, { hour: "numeric", minute: "2-digit" })}
            </Text>
          )}
        </VStack>
        <Button
          size="sm"
          variant={row.uiState === "APPROVED" ? "outline" : "solid"}
          colorPalette={row.uiState === "APPROVED" ? "gray" : "blue"}
          onClick={onReview}
        >
          Review
        </Button>
      </HStack>
      {/* Mileage sub-row — same treatment as PendingWorkdaysSection.
          Independent Approve button; edits/unapprove go through the
          Vehicles tab. Hidden when the driver logged no mileage on
          this date. */}
      {sessions.length > 0 && (
        <HStack
          justify="space-between"
          align="start"
          gap={2}
          wrap="wrap"
          pt={2}
          borderTopWidth="1px"
          borderColor="gray.100"
        >
          <HStack gap={2} align="start" flex={1} minW={0}>
            {/* Mileage sub-row bulk checkbox — only when the workday
                row is also in bulk mode AND this row has pending
                mileage to approve. Independent from the workday
                checkbox above. */}
            {checkbox && pendingMileage.length > 0 && onToggleMileage && (
              <Checkbox.Root
                checked={!!mileageChecked}
                onCheckedChange={() => onToggleMileage()}
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
              </Checkbox.Root>
            )}
            <Box color="fg.muted" mt={0.5}>
              <Car size={12} />
            </Box>
            <VStack align="start" gap={0} flex={1} minW={0}>
              <HStack gap={2}>
                <Text fontSize="xs">
                  {sessions.length} session{sessions.length === 1 ? "" : "s"}
                  {" · "}
                  {totalMiles.toLocaleString()} mi
                  {pendingMileage.length > 0 && (
                    <Text as="span" color="orange.700" fontWeight="medium">
                      {" · "}{pendingMileage.length} pending
                    </Text>
                  )}
                </Text>
                <StatusChip
                  open={sessions.some((s) => s.endedAt == null)}
                  approved={
                    sessions.length > 0 &&
                    sessions.every((s) => s.endedAt != null && s.approvedAt != null)
                  }
                />
              </HStack>
              <Text fontSize="2xs" color="fg.muted" lineClamp={1}>
                {sessions.map((e) => e.vehicleName).join(", ")}
              </Text>
            </VStack>
          </HStack>
          {onReviewMileage && (
            <Button
              size="xs"
              variant="outline"
              colorPalette="blue"
              onClick={onReviewMileage}
            >
              Review
            </Button>
          )}
        </HStack>
      )}
    </VStack>
  );
}

// ── Review dialog ────────────────────────────────────────────────────────

function ReviewDialog({
  row,
  onClose,
  onAfter,
}: {
  row: SuperWorkdayRow;
  onClose: () => void;
  onAfter: () => void;
}) {
  const [startedAt, setStartedAt] = useState(bizToLocalInputValue(row.startedAt));
  const [endedAt, setEndedAt] = useState(row.endedAt ? bizToLocalInputValue(row.endedAt) : "");
  const initialPausedMin = useMemo(
    () => Math.round((row.totalPausedMs ?? 0) / 60000),
    [row.totalPausedMs],
  );
  const [pausedMin, setPausedMin] = useState(initialPausedMin);
  const [saving, setSaving] = useState(false);
  // Same-day approval double-confirm. Only opens when the operator is
  // approving a row whose approval window hasn't opened (today's date).
  // Uses ConfirmDialog's requiredInputValue so the button stays disabled
  // until the operator types APPROVE — that's the second "are you sure"
  // beyond the click that opened the confirm.
  const [sameDayConfirmOpen, setSameDayConfirmOpen] = useState(false);
  const sameDay = !row.adminWindowOpen;

  const dirty = useMemo(() => {
    if (bizToLocalInputValue(row.startedAt) !== startedAt) return true;
    if ((row.endedAt ? bizToLocalInputValue(row.endedAt) : "") !== endedAt) return true;
    if (initialPausedMin !== pausedMin) return true;
    return false;
  }, [row.startedAt, row.endedAt, initialPausedMin, startedAt, endedAt, pausedMin]);

  const liveActive = useMemo(() => {
    const startIso = bizParseLocalInputValue(startedAt);
    const endIso = endedAt ? bizParseLocalInputValue(endedAt) : null;
    if (!startIso) return 0;
    const startMs = Date.parse(startIso);
    const endMs = endIso ? Date.parse(endIso) : Date.now();
    return Math.max(0, endMs - startMs - pausedMin * 60000);
  }, [startedAt, endedAt, pausedMin]);

  function payload() {
    return {
      startedAt: bizParseLocalInputValue(startedAt) || null,
      endedAt: endedAt ? bizParseLocalInputValue(endedAt) : null,
      totalPausedMs: pausedMin * 60000,
      // Server gates same-day edits + approvals on this flag. When
      // false (cutoff passed), the server enforces normally; when true
      // and the cutoff hasn't passed, the server lets the action through
      // and stamps `sameDayBypass: true` in the audit row.
      allowSameDay: sameDay,
    };
  }

  async function saveOnly() {
    if (!dirty) return;
    setSaving(true);
    try {
      await apiPatch(`/api/super/workdays/${row.id}`, payload());
      publishInlineMessage({ type: "SUCCESS", text: "Workday updated." });
      onAfter();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  function onApproveClick() {
    // Same-day approval intercepts here and routes through the typed
    // double-confirm before sending. Post-cutoff approval goes straight
    // through (the regular bulk-confirm gate is enough for those).
    if (sameDay) {
      setSameDayConfirmOpen(true);
      return;
    }
    void approve();
  }

  async function approve() {
    setSaving(true);
    try {
      // Send edits + approval in one call. Server runs the edit first
      // then sets approvedAt atomically.
      await apiPost(`/api/super/workdays/${row.id}/approve`, payload());
      publishInlineMessage({ type: "SUCCESS", text: "Workday approved." });
      onAfter();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Approve failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  async function unapprove() {
    setSaving(true);
    try {
      await apiPost(`/api/super/workdays/${row.id}/unapprove`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Workday unapproved." });
      onAfter();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Unapprove failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  const isApproved = row.uiState === "APPROVED";

  return (
    <>
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>
                Review · {workerLabel(row.user)}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {sameDay && (
                  <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.400" borderRadius="md">
                    <HStack gap={2} align="start">
                      <AlertTriangle size={14} color="var(--chakra-colors-orange-700)" style={{ marginTop: 2 }} />
                      <Text fontSize="xs" color="orange.900">
                        <strong>Same-day approval.</strong> The cutoff hasn't passed
                        yet, so this worker can still edit their own row until then.
                        Approving now locks them out of any correction they discover
                        later. You'll be asked to type APPROVE to confirm.
                      </Text>
                    </HStack>
                  </Box>
                )}
                {row.isOpen && (
                  <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
                    <HStack gap={2}>
                      <AlertTriangle size={14} color="var(--chakra-colors-orange-700)" />
                      <Text fontSize="xs" color="orange.900">
                        This workday was never ended. Set the end time below to close it before approving.
                      </Text>
                    </HStack>
                  </Box>
                )}
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Started at</Text>
                  <input
                    type="datetime-local"
                    value={startedAt}
                    onChange={(e) => setStartedAt(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                    }}
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Ended at</Text>
                  <input
                    type="datetime-local"
                    value={endedAt}
                    onChange={(e) => setEndedAt(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                    }}
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Paused (minutes)</Text>
                  <input
                    type="number"
                    min={0}
                    value={pausedMin}
                    onChange={(e) => setPausedMin(Math.max(0, Number(e.target.value) || 0))}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                    }}
                  />
                </Box>
                <HStack justify="space-between" pt={1} borderTopWidth="1px" borderColor="gray.200">
                  <Text fontSize="sm" fontWeight="semibold">Active total</Text>
                  <Text fontSize="sm" fontWeight="semibold">{fmtDuration(liveActive)}</Text>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="space-between" w="full" gap={2}>
                {/* Left cluster — Unapprove is a "reverse" action, so
                    left-aligned away from the primary Cancel / Save /
                    Approve buttons. Only shown when the row is already
                    approved. */}
                {isApproved ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="red"
                    onClick={() => void unapprove()}
                    disabled={saving}
                  >
                    <RotateCcw size={12} /> <Text ml={1}>Unapprove</Text>
                  </Button>
                ) : <Box />}
                <HStack gap={2}>
                  <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
                  {dirty && (
                    <Button variant="outline" onClick={() => void saveOnly()} disabled={saving}>
                      <Edit3 size={12} /> <Text ml={1}>Save edits</Text>
                    </Button>
                  )}
                  <Button
                    colorPalette={sameDay ? "orange" : "green"}
                    onClick={onApproveClick}
                    disabled={saving || !endedAt}
                  >
                    {saving
                      ? <Spinner size="xs" />
                      : sameDay
                        ? (isApproved ? "Re-approve (same day)" : "Approve (same day)")
                        : (isApproved ? "Re-approve" : "Approve")}
                  </Button>
                </HStack>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
    <ConfirmDialog
      open={sameDayConfirmOpen}
      title="Approve same-day workday?"
      message={`You're approving ${workerLabel(row.user)}'s workday before the cutoff. The worker can no longer fix their own row after this. Only confirm if the workday is genuinely final.`}
      warning="Type APPROVE below to confirm. The override is recorded in the audit log."
      inputLabel="Type APPROVE to enable Confirm"
      inputPlaceholder="APPROVE"
      requiredInputValue="APPROVE"
      confirmLabel="Approve anyway"
      confirmColorPalette="orange"
      onConfirm={() => {
        setSameDayConfirmOpen(false);
        void approve();
      }}
      onCancel={() => setSameDayConfirmOpen(false)}
    />
    </>
  );
}

// ── Bulk approve confirm ──────────────────────────────────────────────────

function BulkApproveConfirm({
  open,
  count,
  totalHours,
  outliers,
  mileageCount,
  sameDay,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  totalHours: number;
  outliers: number;
  /** Number of mileage bundles (worker × date) also selected — surfaced
   *  in the dialog subhead so the operator sees the mix before
   *  confirming. Sub-row bulk-approve orchestration lives client-side;
   *  backend endpoints stay independent. */
  mileageCount: number;
  // True when the operator is bulk-approving BEFORE the approval cutoff.
  // Surfaces the risk callout and gates the Approve button behind a
  // typed "APPROVE" confirmation. Server stamps `sameDayBypass: true` in
  // the audit log for every row approved this way.
  sameDay: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  // Reset the typed value whenever the dialog reopens so a previous
  // confirmation can't carry over into a fresh open.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const typedOk = !sameDay || typed.trim().toUpperCase() === "APPROVE";
  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onCancel(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>
                {sameDay
                  ? "Approve selected same-day items?"
                  : `Approve ${count + mileageCount} item${count + mileageCount === 1 ? "" : "s"}?`}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={2}>
                <Text fontSize="sm">
                  {count > 0 && `${count} workday${count === 1 ? "" : "s"} · ${totalHours.toFixed(1)} active hours total`}
                  {count > 0 && mileageCount > 0 && " · "}
                  {mileageCount > 0 && `${mileageCount} mileage bundle${mileageCount === 1 ? "" : "s"}`}
                </Text>
                {sameDay && (
                  <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.400" borderRadius="md">
                    <HStack gap={2} align="start">
                      <AlertTriangle size={14} color="var(--chakra-colors-orange-700)" style={{ marginTop: 2 }} />
                      <Text fontSize="xs" color="orange.900">
                        <strong>Same-day approval.</strong> The cutoff hasn't passed.
                        Workers can still edit their own rows until then; approving
                        now locks them out of corrections they may discover later.
                        Type <strong>APPROVE</strong> below to enable the button.
                      </Text>
                    </HStack>
                  </Box>
                )}
                {outliers > 0 ? (
                  <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" borderRadius="md">
                    <HStack gap={2}>
                      <AlertTriangle size={14} color="var(--chakra-colors-yellow-700)" />
                      <Text fontSize="xs" color="yellow.900">
                        {outliers} workday{outliers === 1 ? "" : "s"} outside the typical 4–10 hour range — consider reviewing individually.
                      </Text>
                    </HStack>
                  </Box>
                ) : (
                  <Text fontSize="xs" color="fg.muted">
                    All workdays are within the typical 4–10 hour range.
                  </Text>
                )}
                {sameDay && (
                  <input
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="APPROVE"
                    autoFocus
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-orange-300)",
                      borderRadius: "6px",
                      letterSpacing: "0.05em",
                    }}
                  />
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button
                  colorPalette={sameDay ? "orange" : "green"}
                  onClick={onConfirm}
                  disabled={!typedOk}
                >
                  {/* Button count includes BOTH workdays and mileage
                      bundles so it matches the dialog title. Previously
                      it showed only the workday count, which read as
                      "Approve all 2" when a 3rd mileage bundle was
                      also selected — confusing. */}
                  {(() => {
                    const total = count + mileageCount;
                    const label = `${total} item${total === 1 ? "" : "s"}`;
                    return sameDay
                      ? `Approve same-day (${label})`
                      : `Approve all ${label}`;
                  })()}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Backfill dialog ───────────────────────────────────────────────────────

function CreateWorkdayDialog({
  worker,
  workdayDate,
  onClose,
  onAfter,
}: {
  worker: DidntWorkUser;
  workdayDate: string;
  onClose: () => void;
  onAfter: () => void;
}) {
  // Default to the same shape the seed backfill uses: 8 AM → 5 PM ET
  // with 30 minutes of pause. That's a realistic-looking standard
  // workday — Super edits the fields as needed before saving.
  const defaultStartIso = useMemo(
    () => bizInstantFromEtParts(workdayDate, "08:00"),
    [workdayDate],
  );
  const defaultEndIso = useMemo(
    () => bizInstantFromEtParts(workdayDate, "17:00"),
    [workdayDate],
  );
  const [startedAt, setStartedAt] = useState(bizToLocalInputValue(defaultStartIso));
  const [endedAt, setEndedAt] = useState(bizToLocalInputValue(defaultEndIso));
  const [pausedMin, setPausedMin] = useState(30);
  const [saving, setSaving] = useState(false);

  const liveActive = useMemo(() => {
    const startIso = bizParseLocalInputValue(startedAt);
    const endIso = endedAt ? bizParseLocalInputValue(endedAt) : null;
    if (!startIso) return 0;
    const startMs = Date.parse(startIso);
    const endMs = endIso ? Date.parse(endIso) : Date.now();
    return Math.max(0, endMs - startMs - pausedMin * 60000);
  }, [startedAt, endedAt, pausedMin]);

  async function submit() {
    if (saving) return;
    setSaving(true);
    try {
      await apiPost("/api/super/workdays/create", {
        userId: worker.userId,
        workdayDate,
        startedAt: bizParseLocalInputValue(startedAt) || null,
        endedAt: endedAt ? bizParseLocalInputValue(endedAt) : null,
        totalPausedMs: pausedMin * 60000,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Workday created." });
      onAfter();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to create workday.", err) });
    } finally {
      setSaving(false);
    }
  }

  const friendlyDate = fmtDateOpts(`${workdayDate}T12:00:00Z`, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>Add workday · {workerLabel(worker)}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box p={2} bg="blue.50" borderWidth="1px" borderColor="blue.300" borderRadius="md">
                  <Text fontSize="xs" color="blue.900">
                    Backfilling a workday for <b>{workerLabel(worker)}</b> on <b>{friendlyDate}</b>.
                    The row will land in PENDING APPROVAL — you can approve it after creating.
                    Audit logs the action as a Super-side create.
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Started at</Text>
                  <input
                    type="datetime-local"
                    value={startedAt}
                    onChange={(e) => setStartedAt(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                    }}
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Ended at</Text>
                  <input
                    type="datetime-local"
                    value={endedAt}
                    onChange={(e) => setEndedAt(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                    }}
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Paused (minutes)</Text>
                  <input
                    type="number"
                    min={0}
                    value={pausedMin}
                    onChange={(e) => setPausedMin(Math.max(0, Number(e.target.value) || 0))}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                    }}
                  />
                </Box>
                <HStack justify="space-between" pt={1} borderTopWidth="1px" borderColor="gray.200">
                  <Text fontSize="sm" fontWeight="semibold">Active total</Text>
                  <Text fontSize="sm" fontWeight="semibold">
                    {(liveActive / 3600000).toFixed(2)} h
                  </Text>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  onClick={() => void submit()}
                  disabled={saving || !startedAt}
                >
                  {saving ? <Spinner size="xs" /> : "Create workday"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
