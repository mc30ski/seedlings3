"use client";

// ─────────────────────────────────────────────────────────────────────────────
// JobsTab.parts — compartmentalized pieces added on top of the
// baseline JobsTab layout for the blended-role tab.
//
// Nothing here changes the worker-scope layout that JobsTab
// inherits from JobsTab.tsx. Each part renders only when the caller
// asks for it (scope.isAdmin / scope.isSuper) so the worker view is
// untouched.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Card, HStack, Input, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import {
  Activity, Archive, Ban, Bell, CheckCircle2, FastForward, FileText,
  RotateCcw, X, Zap,
  BadgeDollarSign, Calendar, Calculator, CheckSquare, Clock, CreditCard, DollarSign,
  Ghost, HelpCircle, ListChecks, Megaphone, PauseCircle, PlayCircle, Repeat,
  ScrollText, ShieldQuestion, Star, TrendingUp, UserCheck, Users, UserX,
} from "lucide-react";
import MiniStatCard, { type MiniStatColor } from "@/src/ui/components/MiniStatCard";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { usePushNotifications } from "@/src/lib/usePushNotifications";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import type { WorkerOccurrence } from "@/src/lib/types";
import { CompactBanner, type BannerPalette } from "@/src/ui/components/CompactBanner";
import { Dashboard } from "@/src/ui/components/Dashboard";
// Dashboard is re-exported below so JobsTab can keep its single
// import point. It's a shared component — see components/Dashboard.tsx.
export { Dashboard } from "@/src/ui/components/Dashboard";
export { CompactBanner } from "@/src/ui/components/CompactBanner";

// ─── Operations summary (super scope) ────────────────────────────────────
// Collapsed row keeps the primary status counts inline so a Super can
// scan the health of the visible range at a glance. Expanding surfaces
// broader job metrics grouped into logical sections (statuses,
// workflows, financials, attention, scale). All numbers are derived
// from the currently-loaded row set — filter/date changes reflect
// immediately.
export function OpsSummaryStrip({ rows }: { rows: WorkerOccurrence[] }) {
  const metrics = useMemo(() => computeOpsMetrics(rows), [rows]);
  const summaryItems: Array<{ label: string; count: number; palette: BannerPalette }> = [
    { label: "In progress", count: metrics.byStatus.IN_PROGRESS, palette: "green" },
    { label: "Paused", count: metrics.byStatus.PAUSED, palette: "yellow" },
    { label: "Pending payment", count: metrics.byStatus.PENDING_PAYMENT, palette: "orange" },
    { label: "Canceled", count: metrics.byStatus.CANCELED, palette: "gray" },
    { label: "Closed", count: metrics.byStatus.CLOSED, palette: "gray" },
  ];
  // Rendered as a Dashboard section — same visual + header height as
  // the other collapsible sections (DASHBOARD, CLIENT REQUESTS).
  // Summary chips live in the header via summarySlot so they stay
  // visible when collapsed; full metrics render as children on
  // expand.
  return (
    <Dashboard
      storageKey="seedlings:jobsTab:operationsOpen"
      title="Operations"
      icon={Activity}
      summarySlot={
        <HStack gap={2} wrap="nowrap" overflow="hidden" justify="flex-end" w="full">
          {summaryItems.map((it) => (
            <HStack key={it.label} gap={1} flexShrink={0}>
              <Badge size="xs" variant="subtle" colorPalette={it.palette}>{it.count}</Badge>
              <Text fontSize="xs" color="gray.700" display={{ base: "none", md: "inline" }}>
                {it.label}
              </Text>
            </HStack>
          ))}
        </HStack>
      }
    >
      <OpsExpandedDetails metrics={metrics} />
    </Dashboard>
  );
}

type OpsMetrics = {
  totalReal: number;
  totalGhosts: number;
  totalForeign: number;
  byStatus: Record<string, number>;
  byWorkflow: Record<string, number>;
  unassigned: number;
  unconfirmed: number;
  tentative: number;
  vipCount: number;
  repeatingCount: number;
  followupCount: number;
  estimateCount: number;
  announcementCount: number;
  revenueClosed: number;
  revenuePending: number;
  revenueBooked: number;
  avgPrice: number;
  uniqueClients: number;
  uniqueAssignees: number;
};

function computeOpsMetrics(rows: WorkerOccurrence[]): OpsMetrics {
  const byStatus: Record<string, number> = {
    SCHEDULED: 0, IN_PROGRESS: 0, PAUSED: 0, COMPLETED: 0,
    PENDING_PAYMENT: 0, CLOSED: 0, CANCELED: 0, ARCHIVED: 0,
    PROPOSAL_SUBMITTED: 0, ACCEPTED: 0, REJECTED: 0,
  };
  const byWorkflow: Record<string, number> = {
    STANDARD: 0, ONE_OFF: 0, ESTIMATE: 0, TASK: 0,
    REMINDER: 0, EVENT: 0, FOLLOWUP: 0, ANNOUNCEMENT: 0,
  };
  const clientIds = new Set<string>();
  const assigneeIds = new Set<string>();
  let totalReal = 0;
  let totalGhosts = 0;
  let totalForeign = 0;
  let unassigned = 0;
  let unconfirmed = 0;
  let tentative = 0;
  let vipCount = 0;
  let repeatingCount = 0;
  let followupCount = 0;
  let estimateCount = 0;
  let announcementCount = 0;
  let revenueClosed = 0;
  let revenuePending = 0;
  let revenueBooked = 0;
  let pricedRows = 0;
  let pricedSum = 0;

  for (const occ of rows) {
    if ((occ as any)._foreignKind) { totalForeign++; continue; }
    if ((occ as any)._isNextOccurrenceGhost || (occ as any)._isReminderGhost || (occ as any)._isPinnedGhost) {
      totalGhosts++;
      continue;
    }
    totalReal++;

    if (byStatus[occ.status] !== undefined) byStatus[occ.status]++;
    const wf = (occ as any).workflow ?? "STANDARD";
    if (byWorkflow[wf] !== undefined) byWorkflow[wf]++;

    const activeAssignees = (occ.assignees ?? []).filter((a) => a.role !== "observer");
    if (activeAssignees.length === 0) unassigned++;
    for (const a of activeAssignees) if (a.userId) assigneeIds.add(a.userId);

    if (occ.status === "SCHEDULED" && occ.jobId && !(occ as any).isClientConfirmed) unconfirmed++;
    if ((occ as any).isTentative) tentative++;
    if (occ.job?.property?.client?.isVip) vipCount++;
    if (occ.job?.property?.client?.id) clientIds.add(occ.job.property.client.id);
    if ((occ as any).frequencyDays != null) repeatingCount++;
    if (wf === "FOLLOWUP") followupCount++;
    if (wf === "ESTIMATE" || (occ as any).isEstimate) estimateCount++;
    if (wf === "ANNOUNCEMENT") announcementCount++;

    const price = (occ.price ?? (occ as any).proposalAmount ?? 0) as number;
    if (price > 0) {
      pricedRows++;
      pricedSum += price;
      revenueBooked += price;
      if (occ.status === "CLOSED") revenueClosed += price;
      if (occ.status === "PENDING_PAYMENT") revenuePending += price;
    }
  }

  return {
    totalReal,
    totalGhosts,
    totalForeign,
    byStatus,
    byWorkflow,
    unassigned,
    unconfirmed,
    tentative,
    vipCount,
    repeatingCount,
    followupCount,
    estimateCount,
    announcementCount,
    revenueClosed,
    revenuePending,
    revenueBooked,
    avgPrice: pricedRows > 0 ? pricedSum / pricedRows : 0,
    uniqueClients: clientIds.size,
    uniqueAssignees: assigneeIds.size,
  };
}

function OpsExpandedDetails({ metrics }: { metrics: OpsMetrics }) {
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const fmtInt = (n: number) => n.toLocaleString();

  // Every populated status/workflow slot becomes its own MiniStatCard.
  // Empty slots are dropped so the grid doesn't get littered with zeros.
  const statusDefs: Array<{ key: string; label: string; color: MiniStatColor; icon: LucideIconRef }> = [
    { key: "SCHEDULED",          label: "Scheduled",          color: "blue",   icon: Clock },
    { key: "IN_PROGRESS",        label: "In progress",        color: "green",  icon: PlayCircle },
    { key: "PAUSED",             label: "Paused",             color: "orange", icon: PauseCircle },
    { key: "COMPLETED",          label: "Completed",          color: "green",  icon: CheckCircle2 },
    { key: "PENDING_PAYMENT",    label: "Pending payment",    color: "orange", icon: CreditCard },
    { key: "CLOSED",             label: "Closed",             color: "gray",   icon: CheckCircle2 },
    { key: "CANCELED",           label: "Canceled",           color: "gray",   icon: Ban },
    { key: "ARCHIVED",           label: "Archived",           color: "gray",   icon: Archive },
    { key: "PROPOSAL_SUBMITTED", label: "Proposal submitted", color: "purple", icon: ScrollText },
  ];
  const workflowDefs: Array<{ key: string; label: string; color: MiniStatColor; icon: LucideIconRef }> = [
    { key: "STANDARD",     label: "Standard",     color: "blue",   icon: Repeat },
    { key: "ONE_OFF",      label: "One-off",      color: "cyan",   icon: Zap },
    { key: "ESTIMATE",     label: "Estimate",     color: "purple", icon: Calculator },
    { key: "TASK",         label: "Task",         color: "gray",   icon: CheckSquare },
    { key: "REMINDER",     label: "Reminder",     color: "gray",   icon: Bell },
    { key: "EVENT",        label: "Event",        color: "gray",   icon: Calendar },
    { key: "FOLLOWUP",     label: "Follow-up",    color: "orange", icon: FastForward },
    { key: "ANNOUNCEMENT", label: "Announcement", color: "gray",   icon: Megaphone },
  ];
  const activeStatuses = statusDefs.filter((s) => (metrics.byStatus[s.key] ?? 0) > 0);
  const activeWorkflows = workflowDefs.filter((w) => (metrics.byWorkflow[w.key] ?? 0) > 0);

  const attentionSum =
    metrics.unassigned + metrics.unconfirmed + metrics.tentative;

  return (
    <VStack align="stretch" gap={3}>
      {/* Rows in range — what's actually visible in the current filter. */}
      <Section title="Rows in range">
        <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
          <MiniStatCard
            label="Real"
            value={fmtInt(metrics.totalReal)}
            hint="occurrences"
            color="blue"
            icon={ListChecks}
          />
          <MiniStatCard
            label="Ghosts"
            value={fmtInt(metrics.totalGhosts)}
            hint="reminder / pinned / next-visit"
            color="gray"
            icon={Ghost}
          />
          <MiniStatCard
            label="Foreign"
            value={fmtInt(metrics.totalForeign)}
            hint="activity / doc expiration"
            color="gray"
            icon={FileText}
          />
        </SimpleGrid>
      </Section>

      {/* By status — one card per populated bucket. */}
      <Section title="By status">
        {activeStatuses.length > 0 ? (
          <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
            {activeStatuses.map((s) => (
              <MiniStatCard
                key={s.key}
                label={s.label}
                value={fmtInt(metrics.byStatus[s.key] ?? 0)}
                color={s.color}
                icon={s.icon}
              />
            ))}
          </SimpleGrid>
        ) : (
          <Text fontSize="xs" color="fg.muted">No real occurrences in range.</Text>
        )}
      </Section>

      {/* By workflow — same shape as status. */}
      <Section title="By workflow">
        {activeWorkflows.length > 0 ? (
          <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
            {activeWorkflows.map((w) => (
              <MiniStatCard
                key={w.key}
                label={w.label}
                value={fmtInt(metrics.byWorkflow[w.key] ?? 0)}
                color={w.color}
                icon={w.icon}
              />
            ))}
          </SimpleGrid>
        ) : (
          <Text fontSize="xs" color="fg.muted">No workflow data.</Text>
        )}
      </Section>

      {/* Financials — dollar values, colored by role in the P&L. */}
      <Section title="Financials">
        <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
          <MiniStatCard
            label="Revenue (closed)"
            value={fmtMoney(metrics.revenueClosed)}
            color="green"
            icon={DollarSign}
          />
          <MiniStatCard
            label="Pending payment"
            value={fmtMoney(metrics.revenuePending)}
            hint="unpaid"
            color="orange"
            icon={CreditCard}
          />
          <MiniStatCard
            label="Total booked"
            value={fmtMoney(metrics.revenueBooked)}
            hint="all real rows"
            color="blue"
            icon={BadgeDollarSign}
          />
          <MiniStatCard
            label="Avg per priced row"
            value={fmtMoney(metrics.avgPrice)}
            color="teal"
            icon={TrendingUp}
          />
        </SimpleGrid>
      </Section>

      {/* Attention — off-happy-path rows that need review. */}
      <Section title="Attention">
        <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
          <MiniStatCard
            label="Unassigned"
            value={fmtInt(metrics.unassigned)}
            color={metrics.unassigned > 0 ? "red" : "gray"}
            icon={UserX}
          />
          <MiniStatCard
            label="Unconfirmed by client"
            value={fmtInt(metrics.unconfirmed)}
            color={metrics.unconfirmed > 0 ? "orange" : "gray"}
            icon={ShieldQuestion}
          />
          <MiniStatCard
            label="Tentative"
            value={fmtInt(metrics.tentative)}
            color={metrics.tentative > 0 ? "orange" : "gray"}
            icon={HelpCircle}
          />
          <MiniStatCard
            label="VIP-client jobs"
            value={fmtInt(metrics.vipCount)}
            color="purple"
            icon={Star}
          />
          {attentionSum === 0 && metrics.vipCount === 0 && (
            <MiniStatCard
              label="All clear"
              value="0"
              hint="nothing needs review"
              color="green"
              icon={CheckCircle2}
            />
          )}
        </SimpleGrid>
      </Section>

      {/* Scale — mix of population + workflow-type counts. */}
      <Section title="Scale">
        <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
          <MiniStatCard
            label="Unique clients"
            value={fmtInt(metrics.uniqueClients)}
            color="purple"
            icon={Users}
          />
          <MiniStatCard
            label="Unique assignees"
            value={fmtInt(metrics.uniqueAssignees)}
            color="teal"
            icon={UserCheck}
          />
          <MiniStatCard
            label="Repeating jobs"
            value={fmtInt(metrics.repeatingCount)}
            color="blue"
            icon={Repeat}
          />
          <MiniStatCard
            label="Estimates"
            value={fmtInt(metrics.estimateCount)}
            color="purple"
            icon={Calculator}
          />
          <MiniStatCard
            label="Follow-ups"
            value={fmtInt(metrics.followupCount)}
            color="orange"
            icon={FastForward}
          />
          <MiniStatCard
            label="Announcements"
            value={fmtInt(metrics.announcementCount)}
            color="gray"
            icon={Megaphone}
          />
        </SimpleGrid>
      </Section>
    </VStack>
  );
}

// Local alias so the def-arrays above can name the lucide icon
// component type without pulling the type import to the top of the
// file (it's only used in this one place).
type LucideIconRef = typeof Activity;

// Outlined titled card — mirrors the Section wrapper in
// HomeTab so the OPERATIONS section reads as the same visual
// family. Kept local to this file since the shape (title, optional
// loading spinner slot, body) is small and this is the only caller.
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <HStack justify="space-between" mb={3}>
          <Text
            fontSize="xs"
            fontWeight="semibold"
            color="fg.default"
            textTransform="uppercase"
            letterSpacing="wide"
          >
            {title}
          </Text>
        </HStack>
        {children}
      </Card.Body>
    </Card.Root>
  );
}

// ─── Elevated action row (admin / super) ──────────────────────────────────
// Appended to the bottom of each card by JobsTab. Renders nothing
// when both scopes are off, and each button self-hides if the
// current occurrence status doesn't make it meaningful.
//
// Server enforcement:
//   • PATCH /admin/occurrences/:id (status change) — adminGuard
//   • POST /admin/occurrences/:id/archive           — adminGuard
//   • POST /admin/occurrences/:id/force-next        — adminGuard
// The "Super" label here is UI-only for elevation cues; the routes are
// admin-guarded because super implies admin in the app's role model.
export function ElevatedActionRow({
  occ,
  scope,
  onAfter,
  cardMode,
}: {
  occ: WorkerOccurrence;
  scope: { isAdmin: boolean; isSuper: boolean };
  onAfter: () => void;
  /** Optional density passthrough — when the enclosing card is in
   *  "ultra" mode, we hide the elevated row so ultra cards stay a
   *  clean single-line scan. Tapping the card cycles to semi and
   *  the row reappears. */
  cardMode?: "ultra" | "semi" | "expanded";
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Confirmation state MUST live above the early returns below —
  // hooks are position-sensitive, and returning early on some renders
  // (ultra card, no applicable actions) while calling more hooks on
  // others triggers "Rendered more hooks than during the previous
  // render". Kept at the top of the component's hook list.
  type PendingAction = {
    kind: "cancel" | "reopen" | "force-next" | "archive";
    title: string;
    message: string;
    confirmLabel: string;
    confirmColorPalette: string;
    exec: () => Promise<unknown>;
  };
  const [pending, setPending] = useState<PendingAction | null>(null);
  const status = occ.status;
  const propLabel = occ.job?.property?.displayName ?? occ.title ?? "job";

  // Every action is guarded by BOTH scope AND the server-side rules:
  // the ADMIN_TRANSITIONS matrix decides which workflow/status
  // combos the server will accept, and additional semantic gates
  // narrow further (e.g. "Reopen" only reads right on terminal
  // states, "Force next" only makes sense on repeating jobs stuck
  // in PENDING_PAYMENT). Together this means buttons never render
  // for a card where the click would fail or be nonsensical.
  const workflow = (occ as any).workflow as string | undefined;
  const isRepeating = ((occ as any).frequencyDays ?? null) != null;
  const hasJob = !!(occ as any).jobId;

  // Cancel — server matrix decides. Excludes FOLLOWUP / EVENT /
  // ANNOUNCEMENT (no matrix entries) and REMINDER (no CANCELED
  // transition allowed).
  const canAdminCancel = scope.isAdmin && canAdminTransition(workflow, status, "CANCELED");

  // Reopen — combines "the matrix permits going back to SCHEDULED"
  // with the semantic gate "the row is in a terminal-ish state that
  // reads as 'reopen'". Skips IN_PROGRESS/PAUSED where the matrix
  // technically allows SCHEDULED but that's a revert-start, not a
  // reopen — different mental model, better handled elsewhere.
  const isTerminalish =
    status === "CANCELED" ||
    status === "CLOSED" ||
    status === "COMPLETED" ||
    status === "PENDING_PAYMENT";
  const canReopen =
    scope.isSuper &&
    isTerminalish &&
    canAdminTransition(workflow, status, "SCHEDULED");

  // Force next — only meaningful on a REPEATING STANDARD/ONE_OFF job
  // stuck in PENDING_PAYMENT. Non-repeating rows have no "next" to
  // create; TASK/REMINDER/ESTIMATE/etc. don't roll forward.
  const canForceNext =
    scope.isSuper &&
    status === "PENDING_PAYMENT" &&
    hasJob &&
    isRepeating &&
    (workflow === "STANDARD" || workflow === "ONE_OFF" || workflow === undefined);

  // Archive — server matrix decides. Almost always requires the row
  // to be CLOSED (STANDARD/ONE_OFF), CLOSED/CANCELED (TASK), or
  // CLOSED (ESTIMATE).
  const canArchive = scope.isSuper && canAdminTransition(workflow, status, "ARCHIVED");

  const showAdminRow = canAdminCancel;
  const showSuperRow = canReopen || canForceNext || canArchive;
  if (!showAdminRow && !showSuperRow) return null;
  // Follow the card's density cycle — elevated actions are secondary
  // content, so they only surface at the fully-expanded density.
  // Ultra + semi hide them.
  if (cardMode !== "expanded") return null;

  async function run(kind: string, label: string, exec: () => Promise<unknown>) {
    setBusy(kind);
    try {
      await exec();
      publishInlineMessage({ type: "SUCCESS", text: `${label} succeeded.` });
      onAfter();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(`${label} failed.`, err) });
    } finally {
      setBusy(null);
    }
  }

  // Single confirmation flow — dialog state (PendingAction) is
  // declared above alongside the other hooks so all hooks fire in a
  // stable order across renders.
  const runPending = () => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    void run(p.kind, p.confirmLabel, p.exec);
  };

  const adminCancel = () => setPending({
    kind: "cancel",
    title: "Cancel occurrence?",
    message: `Cancel this occurrence at ${propLabel}? It will move to CANCELED and drop off the active timeline.`,
    confirmLabel: "Cancel occurrence",
    confirmColorPalette: "red",
    exec: () => apiPatch(`/api/admin/occurrences/${occ.id}`, { status: "CANCELED" }),
  });
  const superReopen = () => setPending({
    kind: "reopen",
    title: "Reopen occurrence?",
    message: `Reopen this occurrence at ${propLabel}? It will move back to SCHEDULED.`,
    confirmLabel: "Reopen",
    confirmColorPalette: "orange",
    exec: () => apiPatch(`/api/admin/occurrences/${occ.id}`, { status: "SCHEDULED" }),
  });
  const superForceNext = () => setPending({
    kind: "force-next",
    title: "Force next occurrence?",
    message: "Force-create the next occurrence in this series. Skips the normal payment-clearance rule.",
    confirmLabel: "Force next",
    confirmColorPalette: "orange",
    exec: () => apiPost(`/api/admin/occurrences/${occ.id}/force-next`, {}),
  });
  const superArchive = () => setPending({
    kind: "archive",
    title: "Archive occurrence?",
    message: `Archive this occurrence at ${propLabel}? It will be hidden from most views.`,
    confirmLabel: "Archive",
    confirmColorPalette: "red",
    exec: () => apiPost(`/api/admin/occurrences/${occ.id}/archive`, {}),
  });

  // Nested inside Card.Root as a subtle footer. Neutral background
  // (inherits from the card), thin top divider, tight vertical
  // padding — reads as "one more section of this card" rather than a
  // separate colored strip.
  return (
    <VStack align="stretch" gap={0}>
      {showAdminRow && (
        <HStack
          gap={2}
          px={3}
          py={1.5}
          borderTopWidth="1px"
          borderColor="blackAlpha.100"
          bg="blackAlpha.50"
          wrap="wrap"
        >
          <Badge size="xs" variant="subtle" colorPalette="purple">Admin</Badge>
          {canAdminCancel && (
            <Button size="xs" variant="outline" colorPalette="red" onClick={adminCancel} disabled={!!busy}>
              {busy === "cancel" ? <Spinner size="xs" /> : <Ban size={12} />}
              <Text ml={1}>Cancel</Text>
            </Button>
          )}
        </HStack>
      )}
      {showSuperRow && (
        <HStack
          gap={2}
          px={3}
          py={1.5}
          borderTopWidth="1px"
          borderColor="blackAlpha.100"
          bg="blackAlpha.50"
          wrap="wrap"
        >
          <Badge size="xs" variant="subtle" colorPalette="orange">
            <HStack gap={0.5}><Zap size={9} /><Text>Super</Text></HStack>
          </Badge>
          {canReopen && (
            <Button size="xs" variant="outline" colorPalette="orange" onClick={superReopen} disabled={!!busy}>
              {busy === "reopen" ? <Spinner size="xs" /> : <RotateCcw size={12} />}
              <Text ml={1}>Reopen</Text>
            </Button>
          )}
          {canForceNext && (
            <Button size="xs" variant="outline" colorPalette="orange" onClick={superForceNext} disabled={!!busy}>
              {busy === "force-next" ? <Spinner size="xs" /> : <FastForward size={12} />}
              <Text ml={1}>Force next</Text>
            </Button>
          )}
          {canArchive && (
            <Button size="xs" variant="outline" colorPalette="red" onClick={superArchive} disabled={!!busy}>
              {busy === "archive" ? <Spinner size="xs" /> : <Archive size={12} />}
              <Text ml={1}>Archive</Text>
            </Button>
          )}
        </HStack>
      )}
      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ""}
        message={pending?.message ?? ""}
        confirmLabel={pending?.confirmLabel ?? "Confirm"}
        confirmColorPalette={pending?.confirmColorPalette ?? "red"}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </VStack>
  );
}

// ─── Admin-transition matrix (client mirror) ────────────────────────────
// Mirrors ADMIN_TRANSITIONS in apps/api/src/services/jobs.ts. Kept in
// sync manually — if the server's matrix changes, update this too so
// buttons don't render for actions the server will reject.
//
// FOLLOWUP / EVENT / ANNOUNCEMENT workflows deliberately have no
// entries here: the server permits no transitions on those rows, so
// no admin/super button should ever surface for them.
const ADMIN_TRANSITIONS: Record<string, Partial<Record<string, string[]>>> = {
  STANDARD: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "SCHEDULED", "CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "PENDING_PAYMENT", "ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "SCHEDULED", "CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "PENDING_PAYMENT", "ARCHIVED"],
  },
  ESTIMATE: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["SCHEDULED", "PROPOSAL_SUBMITTED", "CANCELED"],
    PROPOSAL_SUBMITTED: ["IN_PROGRESS", "ACCEPTED", "REJECTED"],
    ACCEPTED: ["PROPOSAL_SUBMITTED", "CLOSED"],
    REJECTED: ["PROPOSAL_SUBMITTED", "CLOSED"],
    CLOSED: ["ACCEPTED", "ARCHIVED"],
  },
  TASK: {
    SCHEDULED: ["CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "ARCHIVED"],
    CANCELED: ["SCHEDULED"],
  },
  REMINDER: {
    SCHEDULED: ["CLOSED"],
    CLOSED: ["SCHEDULED"],
  },
};
function canAdminTransition(workflow: string | undefined, from: string, to: string): boolean {
  const wf = workflow ?? "STANDARD";
  return ADMIN_TRANSITIONS[wf]?.[from]?.includes(to) ?? false;
}

// ─── Skeleton row (shared) ────────────────────────────────────────────────
// Compact placeholder that dashboard banners render while their
// initial fetch is in flight. Same 48px shape as CompactBanner so
// the section doesn't jump when the real row lands.
export function SkeletonBanner({ label }: { label: string }) {
  return (
    <Box
      h="48px"
      px={3}
      bg="blackAlpha.50"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      display="flex"
      alignItems="center"
      gap={2}
      aria-busy
      aria-label={`${label} loading`}
    >
      <Spinner size="xs" color="gray.400" />
      <Text fontSize="sm" color="fg.muted">Loading {label}…</Text>
    </Box>
  );
}

// ─── Compliance prompt banner ─────────────────────────────────────────────
// Compact variant of the shipped ComplianceBanner. Reads the same
// `/api/me/policies` endpoint and dispatches the same events, so
// signing a policy anywhere in the app makes this banner disappear.
//
// Palette + glow follow severity:
//   • Any BLOCK-level policy pending → red banner, glow
//   • Only WARN/INFO pending         → orange banner, glow
//   • Nothing pending                → nothing rendered
export function CompliancePromptBanner({
  viewAsUserId,
}: {
  /** When set, the banner reads the impersonated worker's pending
   *  policies via /api/me/policies?viewAsUserId. Mutations (Sign)
   *  are inherently caller-scoped on the server, so the Sign
   *  action is hidden in view-as mode — matches the shipped
   *  ComplianceBanner behavior in HomeTab. */
  viewAsUserId?: string | null;
} = {}) {
  const isViewingAs = !!viewAsUserId;
  type Summary = {
    displayName: string | null;
    required: Array<{ policyId: string; title: string; enforcement: "BLOCK" | "WARN" | "INFO" }>;
  };
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      const url = viewAsUserId
        ? `/api/me/policies?viewAsUserId=${encodeURIComponent(viewAsUserId)}`
        : "/api/me/policies";
      const data = await apiGet<Summary>(url);
      setSummary(data);
    } catch {
      setSummary(null);
    } finally {
      setLoaded(true);
    }
  }, [viewAsUserId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Match the shipped ComplianceBanner behavior: policies:signed
    // / policies:changed events fire from the CALLER's sign wizard,
    // not the impersonated worker's. Skip the refetch in view-as
    // mode so a Super signing their own item doesn't cause the
    // impersonated worker's banner to blink.
    if (isViewingAs) return;
    const onChanged = () => void load();
    window.addEventListener("policies:signed", onChanged);
    window.addEventListener("policies:changed", onChanged);
    return () => {
      window.removeEventListener("policies:signed", onChanged);
      window.removeEventListener("policies:changed", onChanged);
    };
  }, [load, isViewingAs]);

  if (!loaded) return <SkeletonBanner label="compliance" />;
  if (!summary) return null;
  const required = summary.required;
  if (required.length === 0) return null;
  const blocking = required.filter((p) => p.enforcement === "BLOCK");
  const recommended = required.filter((p) => p.enforcement !== "BLOCK");
  const hasBlocking = blocking.length > 0;

  const openWizard = () => {
    window.dispatchEvent(
      new CustomEvent("policies:required", {
        detail: { pendingPolicyIds: [], message: "Compliance banner" },
      }),
    );
  };
  const openProfile = () => {
    window.dispatchEvent(new CustomEvent("navigate:profile", { detail: {} }));
  };

  const summaryText = (() => {
    if (hasBlocking && recommended.length === 0) {
      return blocking.length === 1
        ? "1 required document to sign before you can start work."
        : `${blocking.length} required documents to sign before you can start work.`;
    }
    if (hasBlocking && recommended.length > 0) {
      return `${blocking.length} required + ${recommended.length} recommended document${blocking.length + recommended.length === 1 ? "" : "s"} to sign.`;
    }
    return recommended.length === 1
      ? "1 recommended document to sign when you get a chance."
      : `${recommended.length} recommended documents to sign when you get a chance.`;
  })();

  return (
    <CompactBanner
      palette={hasBlocking ? "red" : "orange"}
      icon={<FileText size={16} />}
      glow
      actions={
        // View-as: Sign is nonsensical (a Super can't sign for
        // another worker — the server rejects). Show View only,
        // matching the shipped ComplianceBanner.
        isViewingAs
          ? [
              {
                label: "View",
                icon: <FileText size={14} />,
                variant: "outline",
                onClick: openProfile,
              },
            ]
          : [
              {
                label: "View",
                icon: <FileText size={14} />,
                variant: "outline",
                onClick: openProfile,
              },
              {
                label: "Sign",
                icon: <CheckCircle2 size={14} />,
                onClick: openWizard,
              },
            ]
      }
      expandedContent={
        <VStack align="stretch" gap={1}>
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
            Pending documents ({required.length})
          </Text>
          {required.map((p) => (
            <HStack key={p.policyId} gap={2} align="center">
              <Badge
                size="xs"
                variant={p.enforcement === "BLOCK" ? "solid" : "subtle"}
                colorPalette={p.enforcement === "BLOCK" ? "red" : "orange"}
              >
                {p.enforcement}
              </Badge>
              <Text fontSize="sm">{p.title}</Text>
            </HStack>
          ))}
        </VStack>
      }
    >
      <Text as="span" fontWeight="semibold">Compliance:</Text>{" "}
      <Text as="span">{summaryText}</Text>
    </CompactBanner>
  );
}

// ─── Admin "View as" selector ────────────────────────────────────────────
// Ported from JobsTab so JobsTab can offer the same view-as
// affordance when scope.isAdmin — without needing an outer wrapper
// component. Fetches /api/workers once, renders an input that opens a
// checkbox-style dropdown; selection state is owned by the caller so
// JobsTab can shadow its own viewAs* props with the picked values.
export type AdminWorker = {
  id: string;
  displayName?: string | null;
  email?: string | null;
  workerType?: string | null;
};
export function AdminViewAsSelector({
  workers,
  selected,
  onChange,
}: {
  workers: AdminWorker[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
        setSearchText("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [workers]);

  const workerItems = useMemo(
    () => workers.map((w) => ({
      label: w.displayName || w.email || w.id,
      value: w.id,
    })),
    [workers],
  );

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workerItems.filter((it) => it.label.toLowerCase().includes(searchLc))
    : workerItems;
  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > 10;

  return (
    <>
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap" flexShrink={0}>
        View as:
      </Text>
      <Box ref={dropRef} position="relative" flex="1">
        <Input
          size="sm"
          w="full"
          placeholder={
            selected.length > 0
              ? selected.map((id) => workerNameMap[id] || "Loading…").join(", ")
              : "All Workers"
          }
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            if (!dropOpen) setDropOpen(true);
          }}
          onFocus={() => {
            setDropOpen(true);
            setSearchText("");
          }}
        />
        {dropOpen && (
          <Box
            position="fixed"
            zIndex={9999}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            rounded="md"
            shadow="lg"
            w="240px"
            mt="1"
            ref={(el: HTMLDivElement | null) => {
              if (el && dropRef.current) {
                const rect = dropRef.current.getBoundingClientRect();
                el.style.top = `${rect.bottom + 4}px`;
                const left = Math.max(8, Math.min(rect.left, window.innerWidth - 248));
                el.style.left = `${left}px`;
              }
            }}
          >
            <Box maxH="250px" overflowY="auto">
              {limited.map((it) => (
                <Box
                  key={it.value}
                  px="3"
                  py="1.5"
                  fontSize="sm"
                  cursor="pointer"
                  bg={selected.includes(it.value) ? "blue.50" : undefined}
                  _hover={{ bg: "gray.100" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(
                      selected.includes(it.value)
                        ? selected.filter((id) => id !== it.value)
                        : [...selected, it.value],
                    );
                  }}
                >
                  <HStack gap={2}>
                    <Text flex="1">{it.label}</Text>
                    {selected.includes(it.value) && <Text color="blue.500" fontWeight="bold">✓</Text>}
                  </HStack>
                </Box>
              ))}
              {hasMore && !searchText && (
                <Text fontSize="xs" color="fg.muted" px="3" py="2" fontStyle="italic">
                  …{filtered.length - 10} more — type to search
                </Text>
              )}
              {filtered.length === 0 && (
                <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </>
  );
}
export function AdminViewAsBadges({
  workers,
  selected,
}: {
  workers: AdminWorker[];
  selected: string[];
}) {
  const map: Record<string, string> = {};
  for (const w of workers) map[w.id] = w.displayName || w.email || w.id;
  if (selected.length === 0) return null;
  return (
    <>
      {selected.map((id) => (
        <Badge key={id} size="sm" colorPalette="blue" variant="solid">
          {map[id] || "Loading…"}
        </Badge>
      ))}
    </>
  );
}

// ─── Browser notification opt-in banner ───────────────────────────────────
// Delegates to the shipped `usePushNotifications` hook so the click
// path is IDENTICAL to Profile → Notifications → "Enable on this
// device": request permission, subscribe to the PushManager, register
// the endpoint on the server (creates the device row). Previously
// this banner only called `Notification.requestPermission()` which
// grants OS permission but never actually subscribed → the user
// tapped Enable, got a success toast, and then Profile still said
// "Enable on this device" because no subscription existed.
//
// Renders only when there's genuinely something to nudge about:
//   • push.status === "default"        → never asked
//   • push.status === "granted-no-sub" → permission but no active sub
// AND the user hasn't dismissed. Dismissal key is intentionally the
// SAME one the shipped Home push banner uses, so Profile's "Show
// reminder again" button restores both surfaces in one tap.
const NOTIF_DISMISS_KEY = "seedlings_pushBannerDismissed";
export function NotificationOptInBanner() {
  const push = usePushNotifications();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(NOTIF_DISMISS_KEY) === "1");
    } catch { /* private mode / no storage — treat as not dismissed */ }
  }, []);

  if (dismissed) return null;
  if (push.status !== "default" && push.status !== "granted-no-sub") return null;

  const enable = async () => {
    const r = await push.subscribe();
    if (r.ok) {
      publishInlineMessage({ type: "SUCCESS", text: "Notifications enabled on this device." });
    } else {
      publishInlineMessage({ type: "ERROR", text: r.error ?? "Could not enable notifications." });
    }
  };

  const dismiss = () => {
    try { localStorage.setItem(NOTIF_DISMISS_KEY, "1"); } catch { /* ignore */ }
    setDismissed(true);
    publishInlineMessage({
      type: "INFO",
      text: "Dismissed. Bring this reminder back anytime from Profile → Notifications → Show reminder again.",
    });
  };

  return (
    <CompactBanner
      palette="blue"
      icon={<Bell size={16} />}
      glow
      actions={[
        {
          label: "Dismiss",
          icon: <X size={14} />,
          variant: "outline",
          palette: "gray",
          onClick: dismiss,
        },
        {
          label: "Enable",
          icon: <Bell size={14} />,
          busy: push.busy,
          onClick: () => void enable(),
        },
      ]}
      expandedContent={
        <VStack align="stretch" gap={1}>
          <Text fontSize="xs" color="fg.muted">
            Push notifications ping this device when a new job is assigned
            to you, when your workday needs attention, and for daily plan
            reminders. Nothing is sent by default — this only turns on
            after you tap Enable.
          </Text>
          <Text fontSize="xs" color="fg.muted" pt={1}>
            Manage or remove enabled devices anytime in Profile →
            Notifications. Dismissing here silences this banner across
            the app; restore it from that same section.
          </Text>
        </VStack>
      }
    >
      <Text as="span" fontWeight="semibold">Enable notifications</Text>{" "}
      <Text as="span">for job + workday alerts.</Text>
    </CompactBanner>
  );
}
