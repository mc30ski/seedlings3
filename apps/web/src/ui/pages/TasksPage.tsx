"use client";

// "Tasks" page — a role-orthogonal worklist that consolidates every
// pending action waiting on the operator into one screen. Purposely
// distinct from the tab navigation: when this page is open, the
// BreadcrumbNav role/category/tab pills are hidden so it's
// unambiguously a separate portfolio of the app.
//
// Architecture: thin wrapper. Re-uses the existing section components
// verbatim (PendingApprovalsSection, OutstandingRequestsSection,
// UnlinkedClientAccountsSection, ChangeRequestsPanel) — each of those
// already self-fetches, self-mutates, self-hides when empty, and
// subscribes to the right event bus. The wrapper just stacks them
// and adds a back header + empty state. For alert types that don't
// yet have a standalone inline section, we render a "shortcut card"
// that takes the operator to the relevant tab in one click (closing
// Tasks on the way).
//
// Visibility by role (visible chrome — server routes still gate too):
//   Super  — every section + every shortcut card
//   Admin  — admin-actionable inline sections + admin shortcut cards
//   Worker — empty by design (most worker tasks live on Home/Jobs);
//            renders the empty state unless a planning/announcement
//            shortcut applies
// Clients never see the Tasks entry point at all.
//
// Closing: the page exposes a single "Back" button in the header;
// the parent (pages/index.tsx) also wires Escape and a re-click of
// the alerts-dropdown "Tasks" link to call onClose.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Card, HStack, IconButton, Text, VStack } from "@chakra-ui/react";
import { ArrowUpRight, CheckCircle2, ChevronDown, ChevronUp, X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
// Every regular tab in pages/index.tsx renders an `<InlineMessage />`
// via wrapWithInlineMessage so the publishInlineMessage event has a
// subscriber. Tasks bypasses the tab tree, so we mount our own here
// — otherwise toasts published from any section action (Approve a
// payment, Resolve a follow-up, etc.) fire into the void and the
// operator sees nothing after a successful action. The InlineMessage
// component is a singleton subscriber — one mounted at the page
// level is all every nested section's toasts need.
import InlineMessage from "@/src/ui/components/InlineMessage";
import PendingApprovalsSection from "@/src/ui/components/PendingApprovalsSection";
import OutstandingRequestsSection from "@/src/ui/components/OutstandingRequestsSection";
import UnlinkedClientAccountsSection from "@/src/ui/components/UnlinkedClientAccountsSection";
import ChangeRequestsPanel from "@/src/ui/components/ChangeRequestsPanel";
import WorkdayStrip from "@/src/ui/components/WorkdayStrip";
import MileageStrip from "@/src/ui/components/MileageStrip";
import PendingUserSignupsSection from "@/src/ui/components/tasks/PendingUserSignupsSection";
import PendingWorkdaysSection from "@/src/ui/components/tasks/PendingWorkdaysSection";
import LedgerFollowupsSection from "@/src/ui/components/tasks/LedgerFollowupsSection";
import TimelineUrgentSection from "@/src/ui/components/tasks/TimelineUrgentSection";
import UnapprovedHoursSection from "@/src/ui/components/tasks/UnapprovedHoursSection";
// Reused VERBATIM from the Payroll tab — same picker, same confirm, same
// endpoint. Matching a name from here is the identical action, so it
// deliberately is not a reimplementation.
import PayrollIdentityReview from "@/src/ui/components/PayrollIdentityReview";
import GuideApprovalsSection from "@/src/ui/components/GuideApprovalsSection";
import { fetchUnmatchedPayrollNames, notifyPayrollChanged } from "@/src/lib/payroll";
import RepeatingPausesDueSection from "@/src/ui/components/tasks/RepeatingPausesDueSection";
import { Dashboard } from "@/src/ui/components/Dashboard";
import type { Scope } from "@/src/lib/scope";

type ShortcutCounts = {
  // `payroll.manage` / `content.approve` queues
  pendingWorkdays: number;
  unapprovedHoursCount: number;
  ledgerFollowupCount: number;
  dueToRecordCount: number;
  streamPauseRemindersCount: number;
  activitiesOverdueCount: number;
  ghostExpiringCount: number;
  ghostExpiredCount: number;
  pendingUsersCount: number;
  // Admin (also visible to super)
  estimateFollowupCount: number;
  overdueCount: number;
  unclaimedCount: number;
  timelineUrgentCount: number;
  // Everyone: announcement alerts are role-agnostic — included so
  // Tasks doesn't render dead-empty for a pure worker whose only
  // pending item is an announcement.
  announcementCount: number;
  // Compliance policy shortcuts (Slice 5).
  policyPendingUploadsCount: number;
  policyPendingApprovalsCount: number;
  policyWorkerPendingCount: number;
  /** `payroll.manage`: Gusto names with no confirmed User yet. */
  payrollUnmatchedCount: number;
  /** `content.approve`: education guides awaiting approval. */
  guideApprovalCount: number;
};

type ShortcutHandlers = {
  goToWorkdayApprovals: () => void;
  goToUnapprovedHours: () => void;
  goToLedgerFollowups: () => void;
  goToDueToRecord: () => void;
  goToCompliance: () => void;
  goToWorkerCompliance: () => void;
  goToPayrollIdentities: () => void;
  goToGuideApprovals: () => void;
  /** Optional occurrenceId — when the operator clicks Review on a
   *  specific row (not the section arrow), we jump to and highlight
   *  just that occurrence rather than expanding every reminder-due
   *  job on the Services tab. */
  goToStreamPauseReminders: (occurrenceId?: string) => void;
  goToExpiringGhosts: () => void;
  goToExpiredGhosts: () => void;
  goToApprovals: () => void;
  goToEstimateFollowups: () => void;
  goToOverdue: () => void;
  goToActivitiesOverdue: () => void;
  goToUnclaimed: () => void;
  goToTimeline: () => void;
  // Collapsible-section "Goto Task" handlers — same close-Tasks-and-
  // jump pattern as the other goTo handlers, just plumbed for the
  // inline-collapsible cards.
  goToPaymentApprovals: () => void;
  goToClientRequests: () => void;
  goToUnlinkedAccounts: () => void;
  goToAnnouncements: () => void;
};

// The three flags are spread into Props rather than nested under a
// `scope` prop, so this intersects Scope instead of holding it. Every
// call site stays as it was.
type Props = Scope & {
  counts: ShortcutCounts;
  handlers: ShortcutHandlers;
  onClose: () => void;
};

// Per-alert dot colors mirror the raw hex values used by the alerts
// dropdown in pages/index.tsx so the count chip on each shortcut card
// matches its sibling row in the dropdown exactly. Keep these in sync
// with the `dotColor` field on each `alerts.push({...})` entry there.
// Yellow-on-yellow contrast — when the dropdown uses #FACC15 (yellow-
// 400) the badge text needs a dark color or it disappears; replicate
// the same logic here.
const DARK_TEXT_DOTS = new Set(["#FACC15"]);

function badgeTextColor(dotColor: string): string {
  return DARK_TEXT_DOTS.has(dotColor) ? "#713F12" : "#fff";
}

// Stable rendering helper for shortcut cards — same shape across all
// alert types, with a Review button that closes Tasks and routes to
// the destination tab. The wrapping `wrap()` is what makes "close
// Tasks on the way out" automatic so each call site stays terse.
function ShortcutCard({
  label,
  count,
  dotColor,
  onReview,
}: {
  label: string;
  count: number;
  // Raw hex pulled from the dropdown alert definitions — see
  // DROPDOWN_ALERT_COLORS above. Using hex (not Chakra palette names)
  // because the dropdown uses raw hex too; palette names would round
  // to slightly different shades and break visual parity.
  dotColor: string;
  onReview: () => void;
}) {
  return (
    <Card.Root variant="outline" borderLeftWidth="4px" style={{ borderLeftColor: dotColor }}>
      <Card.Body px={3} py={2}>
        <HStack gap={3} align="center">
          <Box
            w="22px" h="22px" minW="22px" borderRadius="full"
            fontSize="12px" fontWeight="bold"
            display="flex" alignItems="center" justifyContent="center"
            flexShrink={0}
            style={{ background: dotColor, color: badgeTextColor(dotColor) }}
          >
            {count}
          </Box>
          <Text fontSize="sm" fontWeight="medium" flex={1}>{label}</Text>
          {/* `Open in tab` + ArrowUpRight is the universal "this navigates
              away" affordance — distinct from the chevron used by
              CollapsibleSectionCard for inline expand/collapse. The
              visual difference is what tells the operator whether the
              action keeps them on Tasks or jumps to a tab. */}
          <Button size="sm" variant="outline" onClick={onReview}>
            Goto Task <ArrowUpRight size={14} />
          </Button>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

export default function TasksPage({
  can,
  counts,
  handlers,
  onClose,
}: Props) {
  // Wrap every navigation handler so taking a shortcut also collapses
  // the Tasks view back to the underlying tab tree. Without this each
  // call site would have to remember `onClose()` first; bundling here
  // makes it unconditional and visually consistent.
  const wrap = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // Total count across every section + shortcut visible to this user.
  // Drives the page-level "All clear" empty state and the header
  // pill. Inline sections (PendingApprovalsSection etc.) have their
  // own counts that aren't surfaced via props — we approximate by
  // assuming they're empty when the corresponding shortcut count is
  // zero, which is true for the four standalone components today
  // (they share data sources with the alert counts).
  // Mirrors the role gates used in the section list below so the
  // header chip count agrees with what's actually rendered. Same
  // gates the dropdown uses for its alert entries (see
  // pages/index.tsx alerts.push calls).
  const visibleCount = useMemo(() => {
    let n = 0;
    // Each number counts only if its queue is one you can work. Two
    // role buckets could not express that: a bookkeeper was told about
    // payroll names to match, and a payroll clerk about ledger follow-ups.
    if (can("time.approve")) n += counts.pendingWorkdays + counts.unapprovedHoursCount;
    if (can("books.manage")) n += counts.ledgerFollowupCount;
    if (can("people.approve")) n += counts.pendingUsersCount;
    if (can("compliance.manage"))
      n += counts.policyPendingUploadsCount + counts.policyPendingApprovalsCount;
    if (can("payroll.manage")) n += counts.payrollUnmatchedCount;
    if (can("content.approve")) n += counts.guideApprovalCount;
    if (can("estimates.create")) n += counts.estimateFollowupCount;
    if (can("schedule.manage")) n += counts.overdueCount + counts.unclaimedCount;
    if (can("timeline.view")) n += counts.timelineUrgentCount;
    n += counts.announcementCount;
    // Worker-side "documents to sign" — role-agnostic since anyone with
    // a workerType may have policies to sign, including holders of `schedule.manage`/holders of `settings.manage` who
    // also work in the field.
    n += counts.policyWorkerPendingCount;
    return n;
  }, [can, counts]);

  // Self-scoped-only short-circuit: render the empty-by-design state with
  // a hint about where worker tasks actually live. We still embed
  // WorkdayStrip so a forgotten-to-end workday from yesterday surfaces
  // here too — that's the one worker-specific item with a standalone
  // component today.
  // Nobody with a queue here. Was a pair of role flags, which hid the
  // page from a bookkeeper who has ledger follow-ups waiting.
  if (visibleCount === 0) {
    return (
      <Box maxW="720px" mx="auto" w="full" p={3}>
        <InlineMessage />
        <BackHeader visibleCount={visibleCount} onClose={onClose} />
        <Box mt={3}>
          {/* Mileage embedded for consistency with HomeTab / JobsTab —
              same "one card, two zones" experience across every Worker
              surface that shows the strip. This render is the self-scoped one
              (guarded by the visibleCount check above), so no
              impersonation-hide is needed. */}
          <WorkdayStrip mileageSlot={<MileageStrip embedded />} />
        </Box>
        <EmptyState
          mt={3}
          title="Tasks is mostly an office queue today"
          body="Your day-to-day work lives on the Home and Jobs tabs. Anything time-sensitive shows up there directly."
        />
      </Box>
    );
  }

  return (
    <Box maxW="720px" mx="auto" w="full" p={3}>
      <InlineMessage />
      <BackHeader visibleCount={visibleCount} onClose={onClose} />

      {visibleCount === 0 ? (
        <EmptyState
          mt={3}
          title="All clear"
          body="Nothing is waiting on you right now. New items will appear here as they come in."
        />
      ) : (
        <VStack align="stretch" gap={3} mt={3}>
          {/* Section order mirrors the alerts dropdown's push order in
              pages/index.tsx so the operator can scan either surface
              top-to-bottom and see items in the same position. Two
              concepts that the dropdown collapses into "Payments to
              review" are split here into their own inline sections
              (PendingApprovalsSection + OutstandingRequestsSection)
              since the page has the room for both — that ONE-TO-MANY
              mapping is the only sanctioned divergence, and the
              alert-ordering build gate encodes it explicitly.

              This order is no longer maintained by hand-matching: the
              gate parses both files and fails the build if they drift.
              The comment used to claim the two mirrored each other while
              four entries were actually out of order and one section
              ("Unlinked client accounts") had no dropdown alert at all —
              a claim nothing checked, so it rotted. */}

          {can("schedule.manage") && counts.overdueCount > 0 && (
            <ShortcutCard
              label="Job Overdue"
              count={counts.overdueCount}
              dotColor="#EF4444"
              onReview={wrap(handlers.goToOverdue)}
            />
          )}
          {/* Directly after Job Overdue — same rule, split by workflow, and
              the alerts dropdown pushes them in this order. The
              alert-ordering gate enforces that the two lists agree. */}
          {can("schedule.manage") && counts.activitiesOverdueCount > 0 && (
            <ShortcutCard
              label="Activities Overdue"
              count={counts.activitiesOverdueCount}
              dotColor="#F59E0B"
              onReview={wrap(handlers.goToActivitiesOverdue)}
            />
          )}
          {can("people.approve") && (
            <CollapsibleSectionCard
              label="User sign-ups awaiting approval"
              dotColor="#FB923C"
              loadCount={countPendingUserSignups}
              refreshEvents={["seedlings3:users-changed"]}
              onGoto={wrap(handlers.goToApprovals)}
            >
              <PendingUserSignupsSection />
            </CollapsibleSectionCard>
          )}
          {can("money.approve") && (
            <CollapsibleSectionCard
              label="Pending payment approvals"
              dotColor="#16A34A"
              loadCount={countPendingPaymentApprovals}
              refreshEvents={["seedlings:payments-changed"]}
              onGoto={wrap(handlers.goToPaymentApprovals)}
            >
              <PendingApprovalsSection />
            </CollapsibleSectionCard>
          )}
          {can("money.view") && (
            <CollapsibleSectionCard
              label="Outstanding client invoices"
              dotColor="#FB923C"
              loadCount={countOutstandingClientInvoices}
              refreshEvents={["seedlings:payments-changed"]}
              onGoto={wrap(handlers.goToPaymentApprovals)}
            >
              <OutstandingRequestsSection />
            </CollapsibleSectionCard>
          )}
          {/* `time.manage`, NOT `time.approve`. Both endpoints inside this
              section — POST /workdays/:id/approve and
              POST /mileage/approve-day — are guarded on `time.manage`
              (apps/api/src/routes/time.ts), while this mount asked for
              `time.approve`. Admin and Coordinator hold the second and not
              the first, so both saw "Workdays to approve" on Tasks and got
              a 403 from every Approve they pressed, with nothing on screen
              explaining why. Found by G15, 2026-10-22. */}
          {can("time.manage") && (
            <CollapsibleSectionCard
              label="Workdays to approve"
              dotColor="#6366F1"
              loadCount={countPendingWorkdays}
              onGoto={wrap(handlers.goToWorkdayApprovals)}
            >
              <PendingWorkdaysSection scope={{ can }} />
            </CollapsibleSectionCard>
          )}
          {can("books.manage") && (
            <CollapsibleSectionCard
              label="Ledger follow-ups"
              dotColor="#F59E0B"
              loadCount={countLedgerFollowups}
              refreshEvents={["seedlings3:ledger-followups-changed"]}
              onGoto={wrap(handlers.goToLedgerFollowups)}
            >
              <LedgerFollowupsSection scope={{ can }} />
            </CollapsibleSectionCard>
          )}
          {can("money.record") && counts.dueToRecordCount > 0 && (
            <ShortcutCard
              label="Due to record"
              count={counts.dueToRecordCount}
              dotColor="#F97316"
              onReview={wrap(handlers.goToDueToRecord)}
            />
          )}
          {can("schedule.manage") && (
            <CollapsibleSectionCard
              label="Paused repeating to review"
              dotColor="#A855F7"
              loadCount={countRepeatingPausesDue}
              refreshEvents={["seedlings:stream-pauses-changed"]}
              onGoto={wrap(handlers.goToStreamPauseReminders)}
            >
              <RepeatingPausesDueSection
                onReview={(occurrenceId) =>
                  wrap(() => handlers.goToStreamPauseReminders(occurrenceId))()
                }
              />
            </CollapsibleSectionCard>
          )}
          {/* Next-visit placeholders. Gray dots match the ghost cards these
              land on, so the alert and its destination read as one thing. */}
          {can("schedule.manage") && counts.ghostExpiringCount > 0 && (
            <ShortcutCard
              label="Next visits expiring"
              count={counts.ghostExpiringCount}
              dotColor="#6B7280"
              onReview={wrap(handlers.goToExpiringGhosts)}
            />
          )}
          {can("schedule.manage") && counts.ghostExpiredCount > 0 && (
            <ShortcutCard
              label="Next visits expired"
              count={counts.ghostExpiredCount}
              dotColor="#374151"
              onReview={wrap(handlers.goToExpiredGhosts)}
            />
          )}
          {can("compliance.manage") && counts.policyPendingUploadsCount > 0 && (
            <ShortcutCard
              label="Compliance uploads to review"
              count={counts.policyPendingUploadsCount}
              dotColor="#F97316"
              onReview={wrap(handlers.goToCompliance)}
            />
          )}
          {can("compliance.manage") && counts.policyPendingApprovalsCount > 0 && (
            <ShortcutCard
              label="Policy versions awaiting approval"
              count={counts.policyPendingApprovalsCount}
              dotColor="#3B82F6"
              onReview={wrap(handlers.goToCompliance)}
            />
          )}
          {/* Worker-side "Documents to sign" — surfaces the compliance
              sign wizard shortcut on the personal Tasks page. Rendered
              first (above admin shortcuts) so a worker with pending
              policies sees it before scrolling past admin queues. */}
          {counts.policyWorkerPendingCount > 0 && (
            <ShortcutCard
              label="Documents to sign"
              count={counts.policyWorkerPendingCount}
              dotColor="#DC2626"
              onReview={wrap(handlers.goToWorkerCompliance)}
            />
          )}
          {can("schedule.manage") && (
            <CollapsibleSectionCard
              label="Client change requests"
              dotColor="#F97316"
              loadCount={countChangeRequests}
              refreshEvents={["seedlings3:jobs-changed"]}
              onGoto={wrap(handlers.goToClientRequests)}
            >
              <ChangeRequestsPanel bare scope={{ can }} />
            </CollapsibleSectionCard>
          )}
          {can("identity.link") && (
            <CollapsibleSectionCard
              label="Unlinked client accounts"
              dotColor="#F97316"
              loadCount={countUnlinkedClientAccounts}
              onGoto={wrap(handlers.goToUnlinkedAccounts)}
            >
              <UnlinkedClientAccountsSection scope={{ can }} />
            </CollapsibleSectionCard>
          )}
          {can("estimates.create") && counts.estimateFollowupCount > 0 && (
            <ShortcutCard
              label="Estimate follow-ups"
              count={counts.estimateFollowupCount}
              dotColor="#EC4899"
              onReview={wrap(handlers.goToEstimateFollowups)}
            />
          )}
          {/* `payroll.manage`, and inline rather than a shortcut card: the whole
              action is one picker plus a confirm, so bouncing the operator
              to the Payroll tab to do it would be more steps than doing it
              here. Sits directly above "Job hours awaiting payroll review"
              — both are payroll, and this one blocks a worker from seeing
              their own pay until it is cleared. */}
          {can("payroll.manage") && (
            <CollapsibleSectionCard
              label="Payroll names to match"
              dotColor="#A855F7"
              loadCount={countPayrollUnmatched}
              refreshEvents={["seedlings:payroll-changed"]}
              onGoto={wrap(handlers.goToPayrollIdentities)}
            >
              <PayrollIdentityReview onChanged={notifyPayrollChanged} />
            </CollapsibleSectionCard>
          )}
          {/* Education guides pending approval — `content.approve`. Sits with the
              other review queues; approving is the only way material
              becomes readable by a worker. */}
          {can("content.approve") && (
            <CollapsibleSectionCard
              label="Guides awaiting approval"
              dotColor="#3B82F6"
              loadCount={countGuideApprovals}
              refreshEvents={["seedlings:guides-changed"]}
              onGoto={wrap(handlers.goToGuideApprovals)}
            >
              <GuideApprovalsSection />
            </CollapsibleSectionCard>
          )}
          {can("time.approve") && (
            <CollapsibleSectionCard
              label="Job hours awaiting payroll review"
              dotColor="#F59E0B"
              loadCount={countUnapprovedHours}
              refreshEvents={["seedlings3:jobs-changed"]}
              onGoto={wrap(handlers.goToUnapprovedHours)}
            >
              <UnapprovedHoursSection />
            </CollapsibleSectionCard>
          )}
          {can("schedule.manage") && counts.unclaimedCount > 0 && (
            <ShortcutCard
              label="Unclaimed jobs"
              count={counts.unclaimedCount}
              dotColor="#FACC15"
              onReview={wrap(handlers.goToUnclaimed)}
            />
          )}
          {counts.announcementCount > 0 && (
            <ShortcutCard
              label="Announcements"
              count={counts.announcementCount}
              dotColor="#6D28D9"
              onReview={wrap(handlers.goToAnnouncements)}
            />
          )}
          {can("timeline.view") && (
            <CollapsibleSectionCard
              label="Timeline"
              dotColor="#6366F1"
              loadCount={() => countTimelineUrgent()}
              refreshEvents={["seedlings3:timeline-changed"]}
              onGoto={wrap(handlers.goToTimeline)}
            >
              <TimelineUrgentSection canSeeHidden={can("timeline.manage")} />
            </CollapsibleSectionCard>
          )}
        </VStack>
      )}
    </Box>
  );
}

function BackHeader({
  visibleCount,
  onClose,
}: {
  visibleCount: number;
  onClose: () => void;
}) {
  return (
    <HStack
      justify="space-between"
      align="center"
      borderBottomWidth="1px"
      borderColor="gray.emphasized"
      pb={2}
    >
      <Button size="sm" variant="outline" onClick={onClose}>
        <X size={14} /> <Text ml={1}>Close</Text>
      </Button>
      <HStack gap={2} align="center">
        <Text fontSize="lg" fontWeight="semibold">Tasks</Text>
        {visibleCount > 0 && (
          // Black dot to match the same total-count chip shown next
          // to the "Tasks" entry inside the alerts dropdown
          // (pages/index.tsx — background #0F172A). Used a red Chakra
          // palette before; that made the page header read as an alert
          // even when items were normal-priority.
          <Box
            w="22px" h="22px" minW="22px" borderRadius="full"
            fontSize="12px" fontWeight="bold"
            display="flex" alignItems="center" justifyContent="center"
            flexShrink={0}
            style={{ background: "#0F172A", color: "#fff" }}
          >
            {visibleCount}
          </Box>
        )}
      </HStack>
      {/* Spacer to balance the Back button visually — keeps the title
          horizontally centered without measuring widths. */}
      <Box w="72px" />
    </HStack>
  );
}

// Generic collapsible wrapper that gives an inline section the same
// shortcut-card chrome the rest of the Tasks page uses (colored dot +
// label + Review button), but expands the section IN PLACE instead of
// navigating away. The wrapped section is only mounted when expanded
// — keeps it from making background requests when the operator hasn't
// asked to see it. `loadCount` is what drives both the chip number
// and the self-hide-on-zero behavior; subscribe to `refreshEvents`
// (browser CustomEvent names) so the count refreshes whenever an
// underlying mutation fires — e.g. approve / mark paid / link.
/**
 * A Tasks row — now a thin wrapper over the shared `Dashboard` frame.
 *
 * This used to be a SECOND, independent implementation of the section
 * pattern: its own card, its own chevron, its own expand state, no
 * refresh, no dim, no persistence. Everything the Home/Jobs sections
 * gained through 2026-08-27 had to be re-earned here or silently differ.
 *
 * Two things Tasks needs that the palettes don't give it, both now
 * general Dashboard props:
 *   • `accentColor` — each row's stripe deliberately matches its sibling
 *     entry in the header alerts dropdown, so the per-section colour
 *     coding survives instead of collapsing onto seven palettes.
 *   • `headerAction` — the "Goto Task" arrow, rendered outside the
 *     header <button>.
 *
 * The count chip goes in `summarySlot` rather than `count`: Dashboard's
 * red badge shows only while collapsed, and on Tasks the number is the
 * whole point of the row whether it is open or shut. A Badge is not a
 * button, so it is safe inside the header button.
 */
function CollapsibleSectionCard({
  label,
  dotColor,
  loadCount,
  refreshEvents,
  onGoto,
  children,
}: {
  label: string;
  dotColor: string;
  loadCount: () => Promise<number>;
  refreshEvents?: string[];
  onGoto?: () => void;
  children: React.ReactNode;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCount(await loadCount());
    } catch {
      setCount(0);
    } finally {
      setLoading(false);
    }
  }, [loadCount]);

  useEffect(() => {
    void load();
    if (!refreshEvents || refreshEvents.length === 0) return;
    const handler = () => void load();
    for (const e of refreshEvents) window.addEventListener(e, handler);
    return () => {
      for (const e of refreshEvents) window.removeEventListener(e, handler);
    };
  }, [load, refreshEvents]);

  // count === null is the pre-load phase; render nothing rather than
  // flashing an empty card. count === 0 mirrors the underlying inline
  // sections' "render nothing when empty" semantics.
  if (count === null || count === 0) return null;

  return (
    <Dashboard
      // Keyed by label so each row remembers its own state; Tasks rows
      // come and go as their counts change.
      storageKey={`seedlings:tasks:${label.replace(/\s+/g, "-").toLowerCase()}Open`}
      title={label}
      icon={CheckCircle2}
      variant="neutral"
      accentColor={dotColor}
      // Tasks is a scan list — a dozen queues at once. Rows start shut and
      // the operator opens what they intend to work on.
      defaultOpen={false}
      onRefresh={load}
      refreshing={loading}
      summarySlot={
        <Box
          w="22px" h="22px" minW="22px" borderRadius="full"
          fontSize="12px" fontWeight="bold"
          display="flex" alignItems="center" justifyContent="center"
          flexShrink={0}
          style={{ background: dotColor, color: badgeTextColor(dotColor) }}
        >
          {count}
        </Box>
      }
      headerAction={
        onGoto ? (
          <IconButton
            size="xs"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onGoto();
            }}
            aria-label="Goto Task"
            title="Goto Task — open the source tab"
          >
            <ArrowUpRight size={14} />
          </IconButton>
        ) : undefined
      }
    >
      {children}
    </Dashboard>
  );
}

// Per-section count loaders — each calls the same endpoint the
// underlying inline component does internally. Tiny duplication
// (the inner component will re-fetch when expanded), but keeps the
// wrapper from having to thread state callbacks through the section
// components and lets the chip number show before the section is
// mounted.
async function countUnlinkedClientAccounts(): Promise<number> {
  const list = await apiGet<unknown[]>("/api/clients/unlinked-accounts");
  return Array.isArray(list) ? list.length : 0;
}
async function countPendingPaymentApprovals(): Promise<number> {
  const list = await apiGet<unknown[]>("/api/payments/pending");
  return Array.isArray(list) ? list.length : 0;
}
async function countOutstandingClientInvoices(): Promise<number> {
  const list = await apiGet<unknown[]>("/api/payment-requests/outstanding");
  return Array.isArray(list) ? list.length : 0;
}
async function countChangeRequests(): Promise<number> {
  // Same source the section itself uses internally.
  const list = await apiGet<unknown[]>("/api/change-requests?status=PENDING");
  return Array.isArray(list) ? list.length : 0;
}
async function countPendingUserSignups(): Promise<number> {
  const r = await apiGet<{ pending: number }>("/api/users/pendingCount");
  return r?.pending ?? 0;
}
async function countPendingWorkdays(): Promise<number> {
  const r = await apiGet<{ totalPending: number }>("/api/workdays/pending-summary");
  return r?.totalPending ?? 0;
}
async function countLedgerFollowups(): Promise<number> {
  const r = await apiGet<{ count: number }>("/api/ledger-followups/count");
  return r?.count ?? 0;
}
async function countRepeatingPausesDue(): Promise<number> {
  const r = await apiGet<{ count: number }>("/api/stream-pauses/reminders/count");
  return r?.count ?? 0;
}
async function countTimelineUrgent(): Promise<number> {
  // ONE endpoint — the server decides the row set from the caller's
  // capability, so the client never picks a URL by privilege.
  const r = await apiGet<{ urgent: number; soon: number }>("/api/timeline/upcoming-counts");
  return r?.urgent ?? 0;
}
async function countGuideApprovals(): Promise<number> {
  const r = await apiGet<{ count: number }>("/api/guides/pending-approvals/count");
  return r?.count ?? 0;
}

async function countPayrollUnmatched(): Promise<number> {
  const rows = await fetchUnmatchedPayrollNames();
  return Array.isArray(rows) ? rows.length : 0;
}

async function countUnapprovedHours(): Promise<number> {
  const r = await apiGet<{ count: number }>("/api/occurrences/unapproved-hours-count");
  return r?.count ?? 0;
}

function EmptyState({
  title,
  body,
  mt,
}: {
  title: string;
  body: string;
  mt?: number;
}) {
  return (
    <Card.Root variant="outline" mt={mt}>
      <Card.Body p={6}>
        <VStack gap={2} align="center">
          <Box color="green.fg"><CheckCircle2 size={32} /></Box>
          <Text fontSize="md" fontWeight="semibold">{title}</Text>
          <Text fontSize="sm" color="fg.muted" textAlign="center">{body}</Text>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
