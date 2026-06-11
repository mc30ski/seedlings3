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
import { ChevronLeft, ChevronRight, Calendar, AlertTriangle, CheckCircle2, Edit3, RotateCcw } from "lucide-react";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import {
  bizToday,
  bizAddDays,
  bizToLocalInputValue,
  bizParseLocalInputValue,
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
// The 4 AM rule (settings-driven) is enforced server-side; this UI just
// reads `adminWindowOpen` from the response and disables the action
// buttons when false.
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
      const r = await apiGet<WorkdaysByDateResponse>(`/api/super/workdays/by-date?date=${selectedDate}`);
      setData(r);
      // Clear selection on day change — selected ids only make sense within one day.
      setBulkSelected(new Set());
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load workdays.", err) });
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

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

  function toggleBulk(id: string) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleBulkAll() {
    if (bulkSelected.size === grouped.pending.length) {
      setBulkSelected(new Set());
    } else {
      setBulkSelected(new Set(grouped.pending.map((r) => r.id)));
    }
  }

  async function runBulkApprove() {
    setBulkConfirmOpen(false);
    try {
      const r = await apiPost<{ approved: string[]; alreadyApproved: string[]; failed: { id: string; reason: string }[] }>(
        "/api/super/workdays/bulk-approve",
        { workdayIds: Array.from(bulkSelected) },
      );
      const msg = `Approved ${r.approved.length}${r.alreadyApproved.length ? `, ${r.alreadyApproved.length} already approved` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}.`;
      publishInlineMessage({
        type: r.failed.length === 0 ? "SUCCESS" : "WARNING",
        text: msg,
      });
      if (r.failed.length > 0) {
        // Surface per-row failure reasons so the operator can decide what to do.
        for (const f of r.failed) {
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

  // Sanity stats for the bulk-confirm dialog — count, total active hours,
  // count of "outliers" outside 4–10 hours.
  const bulkStats = useMemo(() => {
    const rows = grouped.pending.filter((r) => bulkSelected.has(r.id));
    let totalMs = 0;
    let outliers = 0;
    for (const r of rows) {
      const ms = activeMs(r);
      totalMs += ms;
      const hours = ms / 3600000;
      if (hours < 4 || hours > 10) outliers += 1;
    }
    return {
      count: rows.length,
      totalHours: totalMs / 3600000,
      outliers,
    };
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
            <Button size="sm" variant="outline" onClick={() => dayShift(-1)} title="Previous day">
              <ChevronLeft size={16} />
            </Button>
            <Box flex="1" minW="220px">
              <Text fontSize="sm" fontWeight="semibold">{headerLabel}</Text>
              {data && (
                <Text fontSize="xs" color="fg.muted">
                  {data.rows.length} workday{data.rows.length === 1 ? "" : "s"} ·{" "}
                  {grouped.approved.length} approved · {grouped.pending.length} pending
                  {grouped.needsEnding.length > 0 && ` · ${grouped.needsEnding.length} needs ending`}
                  {data.didntWork.length > 0 && ` · ${data.didntWork.length} didn't work`}
                  {!data.adminWindowOpen && " · approval locked until cutoff"}
                </Text>
              )}
            </Box>
            <HStack gap={1}>
              <Calendar size={14} color="var(--chakra-colors-gray-500)" />
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
            </HStack>
            <Button size="sm" variant="outline" onClick={() => setSelectedDate(bizToday())}>
              Today
            </Button>
            <Button size="sm" variant="outline" onClick={() => dayShift(1)} title="Next day" disabled={selectedDate >= bizToday()}>
              <ChevronRight size={16} />
            </Button>
          </HStack>
          {!data?.adminWindowOpen && (
            <Box mt={2} p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" borderRadius="md">
              <HStack gap={2}>
                <AlertTriangle size={14} color="var(--chakra-colors-yellow-700)" />
                <Text fontSize="xs" color="yellow.900">
                  Workdays for this date can't be approved yet. The approval window opens at the configured cutoff (default 4 AM ET the next morning).
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
                <WorkdayRow key={r.id} row={r} onReview={() => setReviewRow(r)} />
              ))}
            </SectionCard>
          )}

          {/* PENDING APPROVAL — with bulk approve. */}
          {grouped.pending.length > 0 && (
            <SectionCard title="Pending approval" color="blue" count={grouped.pending.length}>
              <HStack mb={2} gap={2}>
                <Checkbox.Root
                  checked={bulkSelected.size > 0 && bulkSelected.size === grouped.pending.length}
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
                  checkbox
                  checked={bulkSelected.has(r.id)}
                  onToggle={() => toggleBulk(r.id)}
                />
              ))}
            </SectionCard>
          )}

          {/* LIVE TODAY — for today's view only. */}
          {grouped.liveToday.length > 0 && (
            <SectionCard title="Currently working" color="green" count={grouped.liveToday.length}>
              {grouped.liveToday.map((r) => (
                <WorkdayRow key={r.id} row={r} onReview={() => setReviewRow(r)} />
              ))}
            </SectionCard>
          )}

          {/* APPROVED — recap. */}
          {grouped.approved.length > 0 && (
            <SectionCard title="Approved" color="gray" count={grouped.approved.length}>
              {grouped.approved.map((r) => (
                <WorkdayRow key={r.id} row={r} onReview={() => setReviewRow(r)} />
              ))}
            </SectionCard>
          )}

          {/* DIDN'T WORK — short list of workers without a row, restricted
              to users with ≥1 workday in history (server enforces). */}
          {data.didntWork.length > 0 && (
            <SectionCard title="Didn't work" color="gray" count={data.didntWork.length} muted>
              <VStack align="stretch" gap={0}>
                {data.didntWork.map((u) => (
                  <HStack key={u.userId} py={1} fontSize="sm" color="fg.muted">
                    <Text flex="1">{workerLabel(u)}</Text>
                    {u.workerType && <Badge size="xs" variant="outline">{u.workerType}</Badge>}
                  </HStack>
                ))}
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

      {/* Bulk approve confirmation */}
      <BulkApproveConfirm
        open={bulkConfirmOpen}
        count={bulkStats.count}
        totalHours={bulkStats.totalHours}
        outliers={bulkStats.outliers}
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
}: {
  row: SuperWorkdayRow;
  onReview: () => void;
  checkbox?: boolean;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const active = activeMs(row);
  return (
    <HStack
      p={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      gap={2}
      align="center"
      wrap="wrap"
    >
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
          {row.isOpen && (
            <Badge size="xs" colorPalette="orange" variant="solid">⚠ open</Badge>
          )}
          {row.uiState === "APPROVED" && (
            <Badge size="xs" colorPalette="green" variant="subtle">
              <CheckCircle2 size={10} style={{ marginRight: 3 }} />
              approved
            </Badge>
          )}
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          {fmtTimeOpts(row.startedAt, { hour: "numeric", minute: "2-digit" })}
          {" – "}
          {row.endedAt ? fmtTimeOpts(row.endedAt, { hour: "numeric", minute: "2-digit" }) : "(open)"}
          {" · "}
          {fmtDuration(active)} active
          {row.totalPausedMs > 0 && ` · ${fmtDuration(row.totalPausedMs)} paused`}
        </Text>
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
        disabled={!row.adminWindowOpen}
      >
        Review
      </Button>
    </HStack>
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
                {isApproved && (
                  <Box pt={1}>
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() => void unapprove()}
                      disabled={saving}
                    >
                      <RotateCcw size={12} /> <Text ml={1}>Unapprove</Text>
                    </Button>
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
                {dirty && (
                  <Button variant="outline" onClick={() => void saveOnly()} disabled={saving}>
                    <Edit3 size={12} /> <Text ml={1}>Save edits</Text>
                  </Button>
                )}
                <Button colorPalette="green" onClick={() => void approve()} disabled={saving || !endedAt}>
                  {saving ? <Spinner size="xs" /> : isApproved ? "Re-approve" : "Approve"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Bulk approve confirm ──────────────────────────────────────────────────

function BulkApproveConfirm({
  open,
  count,
  totalHours,
  outliers,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  totalHours: number;
  outliers: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onCancel(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>Approve {count} workday{count === 1 ? "" : "s"}?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={2}>
                <Text fontSize="sm">
                  {count} workday{count === 1 ? "" : "s"} · {totalHours.toFixed(1)} active hours total
                </Text>
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
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button colorPalette="green" onClick={onConfirm}>
                  Approve all {count}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
