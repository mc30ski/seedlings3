"use client";
import { useEffect, useState, useCallback, useMemo, useRef, ReactNode } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, Container, Dialog, HStack,
  Spacer, Portal, Spinner, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle, ArrowLeftCircle, Banknote, BarChart3, ChevronDown, Link2, LineChart, TrendingUp } from "lucide-react";
import OnClockBubble from "@/src/ui/components/OnClockBubble";
import { useOffline } from "@/src/lib/offline";
import OfflineQueueDialog from "@/src/ui/dialogs/OfflineQueueDialog";
import PolicyGateInterceptor from "@/src/ui/components/PolicyGateInterceptor";
import MileageReminderInterceptor from "@/src/ui/components/MileageReminderInterceptor";
import { apiGet } from "@/src/lib/api";
import { setCompressionDefaults } from "@/src/lib/imageRedact";
import { getClientImpersonation } from "@/src/lib/impersonation";
import { bizDateKey, bizToday, bizTomorrow, bizYesterday, bizAddDays, bizHour } from "@/src/lib/dates";
import { overdueKind, loadPaymentRequestExpiryHours } from "@/src/lib/overdueRule";
import { ActiveTabExplainerButton } from "@/src/ui/components/TabExplainer";
import { computeDatesFromPreset } from "@/src/lib/datePresets";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import Link from "next/link";
import { UserButton, useAuth, useUser } from "@clerk/clerk-react";

import UsersTab from "@/src/ui/tabs/UsersTab";
import ComplianceTab from "@/src/ui/tabs/ComplianceTab";
import ActivityTab from "@/src/ui/tabs/ActivityTab";
import HistoryTab from "@/src/ui/tabs/HistoryTab";
import SettingsTab from "@/src/ui/tabs/SettingsTab";
import UnclaimedTab from "@/src/ui/tabs/UnclaimedTab";
import WorkdaysTab from "@/src/ui/tabs/WorkdaysTab";
import AuditTab from "@/src/ui/tabs/AuditTab";
import BusinessExpensesTab from "@/src/ui/tabs/BusinessExpensesTab";
import ReconcileTab from "@/src/ui/tabs/ReconcileTab";
import SuppliesTab from "@/src/ui/tabs/SuppliesTab";
import DocumentsTab from "@/src/ui/tabs/DocumentsTab";
import TimelineTab from "@/src/ui/tabs/TimelineTab";
import WeatherBar, { WeatherIcon, type WeatherBarMode } from "@/src/ui/components/WeatherBar";
import WorkdayStrip from "@/src/ui/components/WorkdayStrip";
import MileageStrip from "@/src/ui/components/MileageStrip";
import InventoryTab from "@/src/ui/tabs/InventoryTab";
import VehiclesTab from "@/src/ui/tabs/VehiclesTab";
import JobsTab from "@/src/ui/tabs/JobsTab";
// ServicesTab: one mount, like every other tab. What it offers comes
// from `schedule.view` / `schedule.manage`, read inside the tab from the
// perspective-narrowed capability set.
import ClientsTab from "@/src/ui/tabs/ClientsTab";
import PropertiesTab from "@/src/ui/tabs/PropertiesTab";
import PaymentsTab from "@/src/ui/tabs/PaymentsTab";
import ServicesTab from "@/src/ui/tabs/ServicesTab";
import ClientFeedTab from "@/src/ui/tabs/ClientFeedTab";
import ClientMyJobsTab from "@/src/ui/tabs/ClientMyJobsTab";
import ClientServicesTab from "@/src/ui/tabs/ClientServicesTab";
import ClientPromotionsTab from "@/src/ui/tabs/ClientPromotionsTab";
import ClientStatementsTab from "@/src/ui/tabs/ClientStatementsTab";
import PlanWorkdayWorkflow from "@/src/ui/workflows/PlanWorkdayWorkflow";
import BeginWorkDayWorkflow from "@/src/ui/workflows/BeginWorkDayWorkflow";
import PayrollTab from "@/src/ui/tabs/PayrollTab";
import { WeatherAlertBadge } from "@/src/ui/components/WeatherAlertBadge";
import type { WeatherAlert } from "@/src/lib/weatherAlerts";
import ForecastTab from "@/src/ui/tabs/ForecastTab";
import GuidesTab from "@/src/ui/tabs/GuidesTab";
import { fetchPendingApprovalCount as fetchGuidePendingCount } from "@/src/lib/guides";
import { fetchUnmatchedPayrollNames } from "@/src/lib/payroll";
import TasksTab, { type TaskDef, FiPlus, FiDownload, FiDatabase, FiShare2 } from "@/src/ui/tabs/TasksTab";
import SharePhotosWorkflow from "@/src/ui/workflows/SharePhotosWorkflow";
// Reinstated 2026-10-26 as the TEAM ROLLUP, after being unwired for a
// while. `/statistics` is portfolio-scoped now, so this is also how a portfolio
// lead rolls up their own district: a company-wide holder sees the
// company, a portfolio-limited one sees their portfolio and the page says which.
import StatisticsTab from "@/src/ui/tabs/StatisticsTab";
import ProfileTab from "@/src/ui/tabs/ProfileTab";
import PreviewRoutesTab from "@/src/ui/tabs/PreviewRoutesTab";
import HomeTab from "@/src/ui/tabs/HomeTab";
import ImpersonationBanner from "@/src/ui/components/ImpersonationBanner";
import MulchJobTool from "@/src/ui/tools/MulchJobTool";
import MowingJobTool from "@/src/ui/tools/MowingJobTool";
import NotifyTab from "@/src/ui/tabs/NotifyTab";
import CollectionsTab from "@/src/ui/tabs/CollectionsTab";
import CrewsTab from "@/src/ui/tabs/CrewsTab";
import PricingTab from "@/src/ui/tabs/PricingTab";
import PromotionsTab from "@/src/ui/tabs/PromotionsTab";
import VanityUrlsTab from "@/src/ui/tabs/VanityUrlsTab";
import DisplaysTab from "@/src/ui/tabs/DisplaysTab";

import AppSplash from "@/src/ui/helpers/AppSplash";
import AwaitingApprovalNotice from "@/src/ui/notices/AwaitingApprovalNotice";
import NoRoleNotice from "@/src/ui/notices/NoRoleNotice";
import { setPerspective, CAPABILITIES_CHANGED_EVENT, PERSPECTIVE_CHANGED_EVENT, AREA_LENS_CHANGED_EVENT } from "@/src/lib/impersonation";
import RolesTab from "@/src/ui/tabs/RolesTab";
import PortfoliosTab from "@/src/ui/tabs/PortfoliosTab";

import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import NewJobSetupWorkflow from "@/src/ui/components/NewJobSetupWorkflow";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

import { Me, ClientTabs, StaffTabs, EventTypes } from "@/src/lib/types";
import { FiActivity, FiAlertCircle, FiBarChart2, FiBell, FiBook, FiBookOpen, FiBriefcase, FiCalendar, FiClipboard, FiClock, FiFileText, FiFolder, FiHome, FiLayers, FiLink, FiMapPin, FiMonitor, FiNavigation, FiPackage, FiRefreshCw, FiSearch, FiSettings, FiShield, FiSpeaker, FiSun, FiTag, FiTool, FiTruck, FiUser, FiUserCheck, FiUsers } from "react-icons/fi";
import { GrUserSettings } from "react-icons/gr";
import { AiOutlineTeam } from "react-icons/ai";
import { TfiMoney } from "react-icons/tfi";

import ScrollableUnderlineTabs, {
  TabItem,
} from "../src/ui/components/ScrollableUnderlineTabs";
import BreadcrumbNav from "@/src/ui/components/BreadcrumbNav";
import DayBoardButton from "@/src/ui/components/DayBoardButton";

/**
 * THE BOARD (trophy icon) — MOVED into the header drawer 2026-10-26.
 *
 * It was hidden outright earlier the same day for taking permanent space in
 * the title bar. It is back, but behind the chevron rather than beside the
 * avatar: a thing worth keeping and not worth a slot that is paid for on
 * every screen of every session.
 *
 * This flag still controls the OLD inline slot, next to the copy-link
 * button, and stays false. The drawer renders its own copy — see
 * `headerDrawerOpen` further down. Two callsites, one feature; if the
 * inline one is ever revived, delete the drawer copy rather than shipping
 * the trophy twice.
 *
 * The capability gate on both is CORRECT: the board reads `GET /board`,
 * which is `schedule.view`. It used to ask `hasAnyRole` — "holds any
 * capability at all" — so a payroll clerk was offered the trophy and got a
 * 403 rendered as "Couldn't load the board just now."
 */
const SHOW_DAY_BOARD_BUTTON: boolean = false;
import RoleChip, { type RoleValue } from "@/src/ui/components/RoleChip";
import PortfolioLensChip from "@/src/ui/components/PortfolioLensChip";
import PortfolioScopeNotice from "@/src/ui/components/PortfolioScopeNotice";
import ThemeChip from "@/src/ui/components/ThemeChip";
import TasksPage from "@/src/ui/pages/TasksPage";
import { can, isEntitlement, type Entitlement } from "@repo/permissions";
import { isFieldCleared } from "../src/lib/scope";
import { canSeeTab, hasCapabilityTab } from "@/src/lib/tabRequirements";

// `hasRole` lived here as a local copy. Both it and the Role enum it asked
// about are gone; every question is `scopeCan(<entitlement>)`.

/** Where the user was standing when they opened a workflow. Read by
 *  "Return to Workflow" so stepping out to Equipment/Routes and coming
 *  back lands on the launching tab. */
const WORKFLOW_ORIGIN_KEY = "seedlings_workflow_origin";

/**
 * Which category strip each staff tab lives under.
 *
 * ONE map. There were two — someone with `schedule.manage` one and someone with `settings.manage` one — and a caller with `schedule.manage`
 * copy was missing ten tabs (Ledger, Promotions, Forecast, Reconcile,
 * Workdays, Compliance, Audit, Tools, Vanity, Displays), so a cross-tab jump
 * to any of them resolved no category and left the strip on the old one.
 *
 * Values must match the `category:` on each tab entry below.
 */
const TAB_CATEGORY: Record<string, string> = {
  home: "Work", jobs: "Work", routes: "Work", services: "Work", tasks: "Work",
  equipment: "Equipment", collections: "Equipment", vehicles: "Equipment",
  clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
  payments: "Money", payroll: "Money", pricing: "Money", supplies: "Money",
  ledger: "Money", promotions: "Money", forecast: "Money",
  reconcile: "Records", workdays: "Records", compliance: "Records",
  activity: "Records", history: "Records", timeline: "Records",
  documents: "Records", guides: "Records", audit: "Records",
  "tools-mowing": "Tools", "tools-mulch": "Tools",
  notify: "System", settings: "System", profile: "System",
  vanity: "System", displays: "System", roles: "System", portfolios: "System",
};

export default function HomePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  // Clerk user (image, initials) — drives the title-bar avatar that
  // replaces the Clerk UserButton for staff. Clients still see UserButton.
  const { user: clerkUser } = useUser();
  const { isOffline, isForceOffline, setForceOffline, queueCount } = useOffline();
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);

  const [me, setMe] = useState<Me | null>(null);
  // Is a client "View as" session running? Read once on mount: entering or
  // leaving one reloads the page, so it cannot change under us.
  const [clientViewAs, setClientViewAs] = useState(false);
  // Did the person PICK this shell, or did they just land on it? Persisted
  // next to `topTab`, because the rescue effect runs on every load and the
  // distinction has to survive one.
  const [shellChosen, setShellChosen] = usePersistedState<boolean>("shellChosen", false);
  useEffect(() => { setClientViewAs(!!getClientImpersonation()); }, []);
  const [meLoading, setMeLoading] = useState(true);
  // Splash-done flag: gates browser-permission prompts (geolocation,
  // notifications, etc.) so the OS/browser dialog doesn't pop up over
  // the splash animation and obscure the logo. Flips true after a
  // fixed delay that exceeds the splash's max on-screen time
  // (~8s min duration + 1s fade) — see AppSplash.tsx.
  const [splashDone, setSplashDone] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSplashDone(true), 9500);
    return () => window.clearTimeout(t);
  }, []);
  // NO SURFACE FLAGS. Three role booleans were derived here from three
  // capabilities and then read 50 times, which put the deleted role model
  // back into every decision on the page — including the fifteen alert
  // loaders, where "runs the business" stood in for the entitlement each
  // queue's own endpoint is actually guarded by. Every one of those now asks
  // `scopeCan(<the route's entitlement>)`, so a badge cannot appear for a
  // queue the server would refuse to serve.
  // Is this person internal at all? Was "holds any role". Holding no
  // capability is now a REAL state — somebody on payroll whom nobody has
  // given a role yet, and the unpaid helper — so they get the client shell
  // rather than an empty staff one.
  const hasAnyRole = (me?.capabilities?.length ?? 0) > 0;

  // TWO SHELLS. Was `"client" | "worker" | "admin" | "super"` — three of
  // which were the same staff app rendered three ways. The stored value is
  // migrated on read: a browser holding "worker", "admin" or "super" lands
  // on "staff" rather than on nothing.
  const [topTabRaw, setTopTab] = usePersistedState<"client" | "staff">("topTab", "client");
  const topTab: "client" | "staff" =
    topTabRaw === "client" ? "client" : "staff";

  // WHAT YOU CAN DO DOES NOT DEPEND ON WHICH SCREEN YOU ARE LOOKING AT.
  //
  // Everything on this page asks `scopeCan(<entitlement>)`, over the
  // capability set `/api/me` returned. The server has already applied any
  // active perspective to that set, so a narrower perspective narrows both
  // the tab list and the contents of every tab — and the browser never
  // re-derives it, because re-deriving is what lets the two disagree.
  //
  // What was here instead: three role flags, each ANDed with `topTab`, so
  // the same tab rendered three different ways depending on the shell it
  // was reached through — and the mounts below pinned one of them off on
  // top of that. Between them a tab's content was decided by navigation
  // rather than by entitlement, and a custom role that lit no shell got
  // whichever build its surface fell nearest: a bookkeeper was shown a
  // field worker's Payments screen.
  //
  // It runs the SAME can() the server's route guard runs, over the
  // capabilities /api/me resolved, so a button cannot appear for an action
  // the route would refuse (G15).
  const capabilities = useMemo(
    () => (me?.capabilities ?? []).filter(isEntitlement),
    [me?.capabilities],
  );
  const scopeCan = useCallback(
    (capability: Entitlement) =>
      can(
        {
          kind: "user",
          // The server already applied the payroll gate and any active
          // perspective before sending `capabilities`, so the browser asks
          // about the set it was GIVEN rather than re-deriving one. Re-deriving
          // is exactly what lets the two disagree.
          workerType: me?.workerType ?? null,
          roles: [{ roleId: "__me__", name: "me", entitlements: capabilities }],
          perspective: null,
        },
        capability,
      ),
    [capabilities],
  );
  // One object, spread into every tab, so a future field is added once.
  const scopeBase = { can: scopeCan };

  /**
   * An approved STAFF account that no capability lets into any tab.
   *
   * ONE CONDITION, TWO CONSUMERS. The no-role notice and the tab strip have
   * to agree: the notice says "nothing has been shared with it yet… your
   * profile is still available from the avatar", and a tab strip underneath
   * it calls that a lie. It was one — `hasCapabilityTab` deliberately
   * ignores the ALWAYS tabs, so they kept rendering under the notice, and a
   * brand-new account with no grants landed on Work → Payments reading
   * "Payout: $0.00" above "No payments found."
   *
   * ALWAYS means "no capability distinguishes this tab", not "visible to
   * somebody who has been given nothing at all" — those tabs exist for a
   * worker who is not an administrator, which is a person with capabilities.
   */
  const homelessStaff =
    !meLoading &&
    !!me?.isApproved &&
    !me?.isClientContact &&
    !clientViewAs &&
    !hasCapabilityTab(scopeCan);

  // WHICH TABS EXIST is decided by capability, not by which shell is on
  // screen. Before this, a worker list and a manager list were hardcoded and
  // chosen by surface, so a role that was neither — a bookkeeper holding
  // `books.*` but not `schedule.manage` — had no list to appear on and
  // therefore no app. `TAB_REQUIREMENTS` is the single table; see its
  // header for why it is the one mapping the UI is allowed to keep.
  //
  // A tab's OWN `visible` predicate still applies on top of the capability
  // answer, because a few depend on data rather than permission (Routes
  // needs a workerType). Both must say yes.
  const tabVisible = useCallback(
    (t: TabItem): (() => boolean) =>
      () => {
        if (!canSeeTab(t.value, scopeCan)) return false;
        if (typeof t.visible === "function") return t.visible();
        return t.visible !== false;
      },
    [scopeCan],
  );
  /**
   * Is any tab in this shell reachable?
   *
   * A shell is a grouping of tabs, so the honest test of whether to offer
   * it is whether it contains anything this person may open. The surface
   * capability alone is not that test: it answers "which layout suits
   * you", and a role that lights none of the three — a bookkeeper, a
   * payroll clerk — then had no door to tabs the table says they can see.
   */
  const anyTabVisible = useCallback(
    (tabs: TabItem[]) => tabs.some((t) => canSeeTab(t.value, scopeCan)),
    [scopeCan],
  );

  // Applied to a literal tab array (the shell builds one inline).
  const withCapabilityVisibility = useCallback(
    <T extends TabItem>(tabs: T[]): T[] =>
      tabs.map((t) => ({ ...t, visible: tabVisible(t) })),
    [tabVisible],
  );

  // Captured synchronously at first render — was there a `?tab=` deep-link
  // in the URL when this page mounted? The deep-link resolver strips the
  // param AFTER it routes, which means downstream effects that check
  // `router.query.tab` see an empty query and can't tell the difference
  // between "no deep-link" and "deep-link already consumed." This ref
  // preserves that fact for the lifetime of the mount so the
  // client-default-tab reset effect knows to yield.
  const hadInitialTabDeepLinkRef = useRef(
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("tab"),
  );

  // "Tasks" page open-state. Intentionally NOT persisted across page
  // loads — Tasks is a transient worklist surface; a reload always
  // returns the operator to their underlying tab tree. Toggled from the
  // alerts dropdown's "Tasks" link, the in-page Back button, and an
  // Escape-key handler installed below. See ui/pages/TasksPage.tsx for
  // the page itself.
  const [tasksOpen, setTasksOpen] = useState(false);

  const [clientInnerTab, setClientInnerTab] = usePersistedState<ClientTabs>("clientTab", "public");
  // ONE inner tab and ONE category for the staff shell. There were three
  // of each — worker, admin, super — because there were three shells, so
  // the same feature remembered three different "where was I" positions
  // and switching shell silently moved you.
  const [staffInnerTab, setStaffInnerTab] = usePersistedState<StaffTabs>("staffTab", "home");
  const [staffCategory, setStaffCategory] = usePersistedState<string>("staffCategory", "Work");
  // Migration: existing users have "operations" or "unclaimed" persisted
  // from when those tabs existed / were the default. Redirect them to
  // "home" once, silently — otherwise the shell tries to render an inner
  // tab that no longer exists and shows nothing.
  useEffect(() => {
    // One-shot migration: only inspect the persisted value at mount.
    // Deliberately not keyed on `staffInnerTab` so a user navigating
    // to Home doesn't re-run this on every tab change. Empty
    // deps are intentional here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const stale = staffInnerTab as string;
    if (stale === "operations" || stale === "unclaimed") setStaffInnerTab("home");
  }, []);

  // Migration: removed tab values ("reminders" from the retired Planning
  // tab, "usage" from the retired Equipment Usage tab) are still persisted
  // under the two old per-shell keys. Redirect them to "home" once so
  // nobody lands on a now-nonexistent inner tab and sees a blank portfolio.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const w = staffInnerTab as string;
    if (w === "reminders" || w === "usage") setStaffInnerTab("home");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const a = staffInnerTab as string;
    if (a === "reminders" || a === "usage") setStaffInnerTab("home");
  }, []);

  // Workday-approval badge state — declared up here (before the tab
  // tree) because the WorkdaysTab JSX prop list reads these values
  // synchronously and the tab tree is constructed at the top of this
  // component body. The loader callback gets registered into a ref
  // further down once `markAlertLoaded` is available; the tab calls
  // through the ref so the late binding doesn't break the TDZ.
  const [pendingWorkdays, setPendingWorkdays] = useState<number>(0);
  const [pendingWorkdaysByDate, setPendingWorkdaysByDate] = useState<
    { workdayDate: string; count: number }[]
  >([]);
  // Pending closed-unapproved mileage entries. Same alert dot as
  // workdays (combined display per the "unified daily approval"
  // model) — see the workday/mileage push in the alerts-dropdown
  // builder further down.
  const [pendingMileage, setPendingMileage] = useState<number>(0);
  const [pendingMileageByDate, setPendingMileageByDate] = useState<
    { entryDate: string; count: number }[]
  >([]);
  const [workdaysJumpDate, setWorkdaysJumpDate] = useState<string | null>(null);
  const [workdaysJumpNonce, setWorkdaysJumpNonce] = useState(0);
  // Paused-repeating review handoff — same nonce+payload pattern as
  // WorkdaysTab. Parent bumps the nonce when the operator clicks the
  // alert/task-row; child ServicesTab useEffect keyed on the nonce
  // reads the current occurrenceId payload and applies the filter +
  // auto-expand. Race-free (no timers, no window events, no session
  // storage) — plain React props flow.
  const [streamReviewOccId, setStreamReviewOccId] = useState<string | null>(null);
  const [streamReviewNonce, setStreamReviewNonce] = useState(0);
  const loadPendingWorkdaysRef = useRef<() => Promise<void>>(async () => {});
  // `books.view` (the guard on /ledger-followups/count): open ledger
  // followups (Money → Ledger flags
  // waiting on the operator). Drives the "Ledger followups" entry in the
  // alerts dropdown and pre-applies the "Followups only" filter on click.
  const [ledgerFollowupCount, setLedgerFollowupCount] = useState<number>(0);
  // `books.view` (the guard on /business-expenses/due-soon/count):
  // recurring business expenses whose next expected
  // instance is due within a week (or overdue). Drives the "Due to record"
  // alert in the dropdown + Tasks page shortcut. Source of truth is the
  // Money → Ledger tab's Due-to-Record panel.
  const [dueToRecordCount, setDueToRecordCount] = useState<number>(0);

  // `schedule.view` (the guard on /stream-pauses/reminders/count):
  // stream-paused occurrences whose reminder date has
  // arrived or passed. Drives the "Paused streams to review" alert +
  // Tasks page shortcut. Source of truth is the Services tab where
  // stream-pauses live.
  const [streamPauseRemindersCount, setStreamPauseRemindersCount] = useState<number>(0);
  // Next-visit ghost placeholders needing attention. Two buckets: due within
  // three days (still fixable) and already past due. The expired bucket has
  // no upper bound — there is no grace window any more, so it counts every
  // outstanding stall however old, minus the ones someone with `schedule.manage` has suppressed.
  // Deliberately range-independent — see countGhostExpiry.
  const [ghostExpiringCount, setGhostExpiringCount] = useState<number>(0);
  const [ghostExpiredCount, setGhostExpiredCount] = useState<number>(0);

  // `compliance.view` (the guard on /policies/counts). Two independent
  // buckets:
  //   pendingUploadReviews = worker uploads awaiting approve/reject
  //   pendingApprovals     = policy versions awaiting a second approver
  // Both surface as separate rows in the alerts dropdown so the operator
  // can act on whichever is blocking work.
  const [policyPendingUploadsCount, setPolicyPendingUploadsCount] = useState<number>(0);
  const [policyPendingApprovalsCount, setPolicyPendingApprovalsCount] = useState<number>(0);
  // Worker-side: count of policies the signed-in worker still needs to
  // sign / acknowledge. Drives the personal "Documents to sign" alert
  // and the Tasks shortcut. Interceptor may also open the sign wizard
  // reactively when a gated action fails.
  const [policyWorkerPendingCount, setPolicyWorkerPendingCount] = useState<number>(0);

  // Handle /e/[slug] QR redirect — navigate to equipment tab
  useEffect(() => {
    if (sessionStorage.getItem("equipmentQrSlug")) {
      setTopTab("staff");
      setStaffInnerTab("equipment");
      setStaffCategory("Equipment");
    }
  }, []);

  // Per-tab remount counters. Bumping a key forces React to unmount + remount the
  // corresponding tab, which makes its `usePersistedState` reads pick up freshly-written
  // localStorage values on first render (no flicker).
  //
  // ONE SET. There were two — these three and an `admin*` trio — from when a
  // worker tab and a manager tab were different mounts. Of the six, only the
  // admin equipment key was ever READ; the other five were incremented and
  // consumed by nothing, so `remount: true` on a jobs or payments handoff
  // has been silently doing nothing. Collapsed here; wiring the other two
  // into their tabs' `key` is a separate change, deliberately not made
  // blind.
  const [jobsRemountKey, setJobsRemountKey] = useState(0);
  const [equipmentRemountKey, setEquipmentRemountKey] = useState(0);
  const [paymentsRemountKey, setPaymentsRemountKey] = useState(0);

  // Auto-show worker Home tab on first open of the day (after 5am ET) or after ≥6h idle.
  // Updates `seedlings_lastAppOpenedAt` on every app load. Respects "snooze until next 5am ET".
  useEffect(() => {
    // Only triggers for workers, on initial mount, and not on QR-deep-link
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("equipmentQrSlug")) return;
    if (!me?.workerType) return; // wait until me loads
    try {
      const now = new Date();
      const lastRaw = localStorage.getItem("seedlings_lastAppOpenedAt");
      const last = lastRaw ? new Date(lastRaw) : null;
      const snoozeRaw = localStorage.getItem("seedlings_homeSnoozedUntil");
      const snoozeUntil = snoozeRaw ? new Date(snoozeRaw) : null;
      const etHour = bizHour();
      const isPastFiveEt = etHour >= 5;
      const isLateEvening = etHour >= 22; // 10pm+ ET — don't take over the screen
      const newDay = !last || bizDateKey(last) !== bizDateKey(now);
      const snoozed = snoozeUntil && snoozeUntil > now;
      // Only auto-show on the first open of a new ET day, after 5am, before 10pm.
      const shouldShow = !snoozed && !isLateEvening && isPastFiveEt && newDay;
      if (shouldShow) {
        setTopTab("staff");
        setStaffInnerTab("home");
        setStaffCategory("Work");
      }
      localStorage.setItem("seedlings_lastAppOpenedAt", now.toISOString());
    } catch {}
    // Only run once per mount. Re-evaluating on every me change would re-trigger on every refreshMe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.workerType]);

  const [activeWorkflow, setActiveWorkflow] = useState<string | null>(null);
  const [networkInfoOpen, setNetworkInfoOpen] = useState(false);
  const [workflowEstimateDefaults, setWorkflowEstimateDefaults] = useState<any>(null);

  // Navigation history — stack of {outer, inner, category} states, capped at 10.
  // Both the in-app back button and browser/OS back gesture go through the same path:
  // - In-app button calls history.back() → triggers popstate → restoreFromHistory()
  // - Browser back fires popstate → restoreFromHistory()
  type NavState = { outer: "client" | "staff"; inner: string; category?: string };
  const navHistoryRef = useRef<NavState[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);

  // Use refs for current nav state so closures always read the latest values
  const topTabRef = useRef(topTab);
  const clientInnerTabRef = useRef(clientInnerTab);
  const staffInnerTabRef = useRef(staffInnerTab);
  const staffCategoryRef = useRef(staffCategory);
  topTabRef.current = topTab;
  clientInnerTabRef.current = clientInnerTab;
  staffInnerTabRef.current = staffInnerTab;
  staffCategoryRef.current = staffCategory;

  function getCurrentNavState(): NavState {
    const t = topTabRef.current;
    const inner = t === "client" ? clientInnerTabRef.current : staffInnerTabRef.current;
    const category = t === "client" ? undefined : staffCategoryRef.current;
    return { outer: t, inner, category };
  }

  function pushNavHistory(prev: NavState) {
    const h = navHistoryRef.current;
    h.push(prev);
    if (h.length > 10) h.shift();
    setCanGoBack(h.length > 0);
    try { history.pushState({ seedlingsNav: true }, ""); } catch {}
  }

  /** Move the app to a saved nav position — refs first so a subsequent
   *  pushNavHistory reads the restored state, then React state. Shared by
   *  the back button and by "Return to Workflow", which needs to land the
   *  user wherever they launched the workflow from. */
  function applyNavState(prev: NavState) {
    topTabRef.current = prev.outer as any;
    if (prev.outer === "client") clientInnerTabRef.current = prev.inner as any;
    // `else` — there are two shells. This was three more branches, one
    // per old shell, with identical bodies; `outer` comes from
    // getCurrentNavState() which returns topTabRef, typed
    // "client" | "staff", so none of them could ever run.
    else { staffInnerTabRef.current = prev.inner as any; if (prev.category) staffCategoryRef.current = prev.category; }
    // Now set React state (no skipNextPush needed — onOuterChange/onInnerChange only fire from user clicks)
    setTopTab(prev.outer as any);
    if (prev.outer === "client") setClientInnerTab(prev.inner as any);
    else { setStaffInnerTab(prev.inner as any); if (prev.category) setStaffCategory(prev.category); }
  }

  function restoreFromHistory() {
    const h = navHistoryRef.current;
    if (h.length === 0) return;
    const prev = h.pop()!;
    setCanGoBack(h.length > 0);
    applyNavState(prev);
  }

  /**
   * Open a workflow, remembering where the user was when they opened it.
   *
   * Use this for every genuine LAUNCH. Do NOT use it to resume a paused
   * workflow (the "Return to Workflow" button) — that would overwrite the
   * origin with whatever tab the workflow had sent the user out to, which
   * is exactly the tab they don't want to come back to.
   */
  /** Day the plan-workday picker should open on, set by whichever
   *  launcher started it. Null = let the workflow pick. */
  const [planWorkdayDate, setPlanWorkdayDate] = useState<string | null>(null);

  function launchWorkflow(id: string, opts?: { targetDate?: string }) {
    setPlanWorkdayDate(opts?.targetDate ?? null);
    const origin = getCurrentNavState();
    try {
      localStorage.setItem(WORKFLOW_ORIGIN_KEY, JSON.stringify(origin));
    } catch { /* non-fatal — return falls back to worker/tasks */ }
    // Set state directly too. The reader effect only re-checks on mount and
    // on storage/navigate events, so relying on it alone would leave the
    // Return button reading a stale origin if the user stepped out fast.
    setWorkflowOrigin(origin);
    setActiveWorkflow(id);
  }

  function handleBackButton() {
    if (navHistoryRef.current.length === 0) return;
    // Use history.back() so the browser stack stays in sync — popstate will call restoreFromHistory
    try { history.back(); } catch { restoreFromHistory(); }
  }

  // Listen for browser back button / OS back gesture
  useEffect(() => {
    function handlePopstate(e: PopStateEvent) {
      if (navHistoryRef.current.length > 0) {
        restoreFromHistory();
      }
    }
    window.addEventListener("popstate", handlePopstate);
    return () => window.removeEventListener("popstate", handlePopstate);
  }, []);

  // Track paused workflow for banner display
  const [pausedWorkflow, setPausedWorkflow] = useState<string | null>(null);
  // Where the paused workflow was launched from. A workflow step can send
  // the user out to another tab (Equipment Check → Equipment, Today's Route
  // → Routes); returning has to land them back where they started, not on a
  // hardcoded tab. Without this, launching from Home and stepping out to
  // Equipment dropped you on +Actions on the way back.
  const [workflowOrigin, setWorkflowOrigin] = useState<NavState | null>(null);
  useEffect(() => {
    const check = () => {
      try {
        const rawOrigin = localStorage.getItem(WORKFLOW_ORIGIN_KEY);
        setWorkflowOrigin(rawOrigin ? (JSON.parse(rawOrigin) as NavState) : null);
      } catch { setWorkflowOrigin(null); }
      try {
        if (localStorage.getItem("seedlings_beginWorkday_paused") === "1") return setPausedWorkflow("begin-workday");
        if (localStorage.getItem("seedlings_planWorkday_paused") === "1") return setPausedWorkflow("plan-workday");
      } catch {}
      setPausedWorkflow(null);
    };
    check();
    window.addEventListener("storage", check);
    const onCheck = () => setTimeout(check, 50);
    window.addEventListener("navigate:staffTab", onCheck);
    return () => { window.removeEventListener("storage", check); window.removeEventListener("navigate:staffTab", onCheck); };
  }, []);

  // Escape closes the Tasks page — third close affordance alongside
  // the in-page Back button and the alerts-dropdown "Tasks" link
  // toggle. Skips when Tasks isn't open so we don't intercept Escape
  // for the rest of the app.
  useEffect(() => {
    if (!tasksOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTasksOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tasksOpen]);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    colorPalette: string;
    onConfirm: () => void;
  } | null>(null);

  async function downloadSummary() {
    try {
      const { text } = await apiGet<{ text: string }>("/api/export-summary");
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `seedlings-summary-${bizToday()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed. Please try again.");
    }
  }

  async function downloadRaw() {
    try {
      const data = await apiGet<Record<string, unknown>>("/api/export");
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `seedlings-export-${bizToday()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed. Please try again.");
    }
  }



  const staffTasks: TaskDef[] = [
    {
      id: "new-job-setup",
      label: "New Job Service",
      // POST /clients + POST /properties are `clients.manage`; POST /jobs
      // is `schedule.manage`. The workflow runs all three in one pass, so
      // it needs both — holding one gets you a wizard that dies halfway.
      requires: ["clients.manage", "schedule.manage"],
      description: "Create a new client, property, job, and first occurrence",
      icon: FiPlus,
      colorPalette: "green",
      bgColor: "green.faint",
      onClick: () => launchWorkflow("new-job-setup"),
    },
    {
      id: "share-photos",
      label: "Share Photos",
      // Its only endpoint is `GET /photos` — `schedule.contribute`. That
      // is on the base rung, so a worker keeps this one; the card reads
      // and downloads, it does not publish.
      requires: ["schedule.contribute"],
      description: "Select photos from jobs and share to Instagram, social media, or download",
      icon: FiShare2,
      colorPalette: "orange",
      bgColor: "orange.faint",
      onClick: () => launchWorkflow("share-photos"),
    },
    {
      id: "export-summary",
      label: "Export Summary",
      // `GET /export-summary` is `books.view`, same as Export All Data.
      // Ungated, this offered every holder of `schedule.view` a button
      // whose only outcome was a 403 reported as "Export failed".
      requires: ["books.view"],
      description: "Download a human-readable summary of all your data",
      icon: FiDownload,
      colorPalette: "blue",
      bgColor: "blue.faint",
      onClick: () =>
        setConfirmAction({
          title: "Export Summary",
          message: "This will download a human-readable summary of all your data. Continue?",
          confirmLabel: "Download",
          colorPalette: "blue",
          onConfirm: downloadSummary,
        }),
    },
    {
      id: "export-raw",
      label: "Export All Data",
      description: "Download all raw data as JSON for backup or analysis",
      icon: FiDatabase,
      colorPalette: "purple",
      bgColor: "purple.faint",
      // `GET /export` needs `books.view`. "Super" was a stand-in for it,
      // so a bookkeeper — whose whole role is the books — was refused.
      //
      // ONE MECHANISM. This used to ALSO carry `disabled` + a "you don't
      // have permission" message and a refusal branch in onClick, which
      // made the same capability answer the question in three places. The
      // card is now absent when the capability is, like every other entry.
      requires: ["books.view"],
      onClick: () => {
        setConfirmAction({
          title: "Export Raw Data",
          message: "This will download all raw data as JSON. This may be a large file. Continue?",
          confirmLabel: "Download",
          colorPalette: "purple",
          onConfirm: downloadRaw,
        });
      },
    },
  ];

  // Separate error state from `me === null` (the latter is a valid
  // signed-out state). `meError` is set only when the /api/me fetch
  // actually failed or timed out — used to render a retryable error
  // banner instead of a blank tabless page.
  //
  // We capture FULL error diagnostics (elapsed ms, HTTP status if any,
  // raw error message, timestamp, endpoint) so the banner can show
  // exactly what went wrong. Without this the user gets a generic
  // "Couldn't load your profile" and no way to distinguish a
  // timeout from a 500 from a network reset — every intermittent
  // failure looks identical.
  type MeErrorDetails = {
    message: string;
    status?: number;
    kind: "timeout" | "http" | "network" | "unknown";
    elapsedMs: number;
    timestamp: string;
    endpoint: string;
    responseBody?: string;
  };
  const [meError, setMeError] = useState<MeErrorDetails | null>(null);
  const loadMe = useCallback(async () => {
    setMeLoading(true);
    setMeError(null);
    // Timeout must be LONG. The earlier 12s value was way too aggressive —
    // it fired during legitimate Neon cold-starts and Clerk verification
    // latency, killing requests the server would have completed if given
    // another few seconds. That aborted-by-client failure showed up in the
    // UI as "the server never responded," which was misleading — the
    // request never got a chance TO respond. Vercel Serverless Functions
    // have their own upstream timeout (60s+ on Pro plans) which is the
    // real ceiling; the client-side timeout only exists as a last-resort
    // guard against a truly stuck fetch.
    const REQUEST_TIMEOUT_MS = 60_000;
    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();
    let timedOut = false;
    try {
      const data = await Promise.race([
        apiGet<Me>("/api/me"),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            reject(new Error(`Client-side timeout after ${REQUEST_TIMEOUT_MS}ms — the request never returned.`));
          }, REQUEST_TIMEOUT_MS),
        ),
      ]);
      setMe(data);
    } catch (err: any) {
      setMe(null);
      const elapsedMs = Date.now() - startedAt;
      const status: number | undefined = typeof err?.status === "number" ? err.status : undefined;
      let kind: MeErrorDetails["kind"] = "unknown";
      if (timedOut) kind = "timeout";
      else if (status !== undefined) kind = "http";
      else if (err?.name === "TypeError" || /fetch|network|failed/i.test(String(err?.message))) kind = "network";
      let responseBody: string | undefined;
      if (err?.body !== undefined) {
        try { responseBody = typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2); }
        catch { /* ignore */ }
      }
      const details: MeErrorDetails = {
        message: String(err?.message ?? err ?? "Unknown error"),
        status,
        kind,
        elapsedMs,
        timestamp: startedIso,
        endpoint: "GET /api/me",
        responseBody,
      };
      // Always log full details to console so it's visible in DevTools
      // regardless of the banner layout.
      // eslint-disable-next-line no-console
      console.error("[loadMe] request failed", details, "raw error:", err);
      setMeError(details);
    } finally {
      setMeLoading(false);
    }
  }, []);

  // Silent refresh — updates me without showing loading spinner
  // TAKING A PERSPECTIVE NO LONGER RELOADS THE PAGE.
  //
  // It used to, because every response on screen was fetched under the
  // outgoing lens and a reload is the crudest way to re-ask for all of
  // them. Two cheaper things do the same job:
  //
  //   `/api/me` is refetched, and that cascades on its own — `capabilities`
  //   is a new array, so the `scopeCan` callback changes identity, so every
  //   title-bar count and alert callback built on it changes identity, so
  //   their effects re-run. The counts come back narrowed without anything
  //   here naming them.
  //
  //   `contentGeneration` is appended to the key on the tab content, which
  //   remounts the open tab so its own fetches run again. Nothing else
  //   re-asks for a tab's data — that is the half `refreshMe` cannot reach.
  //
  // Client "View as" still reloads, and should: it changes WHO the caller
  // is rather than narrowing what one caller may see.
  const [contentGeneration, setContentGeneration] = useState(0);
  const refreshMe = useCallback(async () => {
    try {
      const data = await apiGet<Me>("/api/me");
      setMe(data);
    } catch {}
  }, []);

  useEffect(() => {
    const onPerspectiveChanged = () => {
      void (async () => {
        await refreshMe();
        setContentGeneration((g) => g + 1);
      })();
    };
    window.addEventListener(PERSPECTIVE_CHANGED_EVENT, onPerspectiveChanged);
    // Capabilities changed, not the lens: refetch `me` and stop there. No
    // content remount, because every response on screen was fetched as the
    // same person asking the same question — only what they are ALLOWED to
    // do has moved.
    const onCapabilitiesChanged = () => { void refreshMe(); };
    window.addEventListener(CAPABILITIES_CHANGED_EVENT, onCapabilitiesChanged);
    // THE PORTFOLIO LENS NEEDS EXACTLY THE SAME TREATMENT, for the same reason:
    // every response on screen was fetched through the outgoing lens, so
    // each one may be answering about a district nobody is looking at any
    // more. `refreshMe` is not strictly needed here — a lens changes WHERE,
    // not WHAT MAY BE DONE, so the capability set is identical — but the
    // remount is, and keeping the two paths the same shape is worth more
    // than skipping one request.
    window.addEventListener(AREA_LENS_CHANGED_EVENT, onPerspectiveChanged);
    return () => {
      window.removeEventListener(PERSPECTIVE_CHANGED_EVENT, onPerspectiveChanged);
      window.removeEventListener(CAPABILITIES_CHANGED_EVENT, onCapabilitiesChanged);
      window.removeEventListener(AREA_LENS_CHANGED_EVENT, onPerspectiveChanged);
    };
  }, [refreshMe]);

  useEffect(() => {
    if (authLoaded && isSignedIn) {
      void loadMe();
    } else if (authLoaded && !isSignedIn) {
      setMe(null);
      setMeLoading(false);
    }
  }, [authLoaded, isSignedIn, loadMe]);

  // Load app-wide compression defaults once a signed-in session resolves.
  // PHOTO_MAX_EDGE_PX / PHOTO_JPEG_QUALITY drive every photo upload path
  // (occurrences, equipment, properties, receipts). New photos use whatever
  // is configured at upload time — already-stored photos are untouched.
  // Staff-only: /api/settings is staff-gated and 403s for
  // pure client accounts (clients don't upload photos anyway, so they
  // don't need the compression defaults).
  useEffect(() => {
    if (!authLoaded || !isSignedIn || !hasAnyRole) return;
    void (async () => {
      try {
        const list = await apiGet<Array<{ key: string; value: string }>>("/api/settings");
        if (!Array.isArray(list)) return;
        const edge = Number(list.find((s) => s.key === "PHOTO_MAX_EDGE_PX")?.value);
        const quality = Number(list.find((s) => s.key === "PHOTO_JPEG_QUALITY")?.value);
        setCompressionDefaults({
          maxEdge: Number.isFinite(edge) ? edge : undefined,
          quality: Number.isFinite(quality) ? quality : undefined,
        });
      } catch {
        // Silent — defaults stay in effect.
      }
    })();
  }, [authLoaded, isSignedIn, hasAnyRole]);

  useEffect(() => {
    // Don't reset tabs until we know what the person can do.
    if (!me) return;
    // TWO SHELLS NOW: the client portal, and staff. Which of three staff
    // shells you landed on used to be a question; there is one, and what
    // you see inside it comes from your entitlements.
    //
    // `staffTabs` is declared further down the component. Safe, because an
    // effect body runs AFTER the function returns — but do not lift it into
    // the deps array or the render path, where it would be a TDZ error.
    const staffReachable = anyTabVisible(staffTabs);
    if (topTab !== "client" && !staffReachable) setTopTab("client");
    // A first sign-in stamps "client", which for a bookkeeper is an empty
    // room. Move them to the staff shell when they have one.
    //
    // NOT during a client "View as" session. `/api/me` answers as the
    // operator there, so `isClientContact` is false and this threw them
    // straight back out of the portal they had just entered — the whole
    // feature, silently dead, which is the failure mode
    // docs/features/client-view-as.md was written after.
    if (
      topTab === "client" &&
      !me.isClientContact &&
      !clientViewAs &&
      !shellChosen &&
      staffReachable
    ) {
      setTopTab("staff");
    }
  }, [topTab, me, anyTabVisible, setTopTab, clientViewAs, shellChosen]);

  // On every load, a signed-in approved client lands on "My Properties" —
  // the personalized view is the useful landing target every time, not
  // just the first session. Fires once per mount via the ref so the
  // client can still switch to Community / Services mid-session and stay
  // there for the rest of THIS visit; the next load reseeds on My
  // Properties. Skipped when they're already on my-jobs (no-op nudge)
  // OR when a `?tab=` deep-link is present in the URL (the deep-link
  // resolver's target must win over the default landing, otherwise
  // links from /pay/[token] et al can't route the client anywhere but
  // My Properties).
  const clientDefaultFlippedRef = useRef(false);
  useEffect(() => {
    if (!me?.isApproved) return;
    // A customer, not staff. `isClientContact` is the honest test; the
    // old one asked whether they held two particular capabilities. An
    // operator in a client "View as" session is looking at the portal as
    // that customer, so they land where the customer would.
    if (!me?.isClientContact && !clientViewAs) return;
    if (topTab !== "client") return;
    if (clientInnerTab === "my-jobs") return;
    if (clientDefaultFlippedRef.current) return;
    // Yield when a `?tab=` deep-link was present on load — the deep-link
    // resolver strips the param before running, so a live check on
    // router.query.tab always misses. hadInitialTabDeepLinkRef is
    // captured synchronously at mount and preserves the fact.
    if (hadInitialTabDeepLinkRef.current) return;
    clientDefaultFlippedRef.current = true;
    setClientInnerTab("my-jobs");
  }, [me?.isApproved, topTab, clientInnerTab, setClientInnerTab, clientViewAs]);

  // Re-fetch me silently when switching top tabs so admin changes are reflected
  useEffect(() => {
    if (!meLoading) void refreshMe();
  }, [topTab]);

  // No-op wrapper — kept for backward compatibility with the 54 tab
  // registration call sites. InlineMessage is now mounted ONCE at the
  // app root (see _app.tsx). Rendering it here per-tab would
  // double-toast every publish + reintroduce the fixed-positioning
  // race that made toasts "float" during tab switches.
  function wrapWithInlineMessage(tab: ReactNode) {
    return tab;
  }

  const clientTabs: TabItem[] = [
    // My Properties is the top + default landing tab for signed-in
    // approved clients — that's the personalized view they care about
    // when they open the app. Community and Services sit behind it for
    // anonymous browsing.
    {
      value: "my-jobs",
      label: "My Properties",
      icon: FiBriefcase,
      // A customer tab. Shown to somebody attached to a customer record,
      // which is what makes them a customer — not the absence of two
      // particular staff capabilities. An operator in a client "View as"
      // session counts: `/api/me` answers as the operator, so this read
      // false and hid the two tabs the session exists to show.
      visible: () =>
        !!isSignedIn && ((!!me?.isApproved && !!me?.isClientContact) || clientViewAs),
      content: <ClientMyJobsTab />,
    },
    {
      // Self-serve statement generator (PDF/CSV of confirmed payments
      // for a chosen property + date range). Sits right under My
      // Properties so tax-time exports are one click from the
      // personalized landing tab.
      value: "statements",
      label: "Statements",
      icon: FiFileText,
      // A customer tab. Shown to somebody attached to a customer record,
      // which is what makes them a customer — not the absence of two
      // particular staff capabilities. An operator in a client "View as"
      // session counts: `/api/me` answers as the operator, so this read
      // false and hid the two tabs the session exists to show.
      visible: () =>
        !!isSignedIn && ((!!me?.isApproved && !!me?.isClientContact) || clientViewAs),
      content: <ClientStatementsTab />,
    },
    {
      value: "public",
      label: "Community",
      icon: FiActivity,
      content: <ClientFeedTab />,
    },
    {
      // Value is `client-services`, NOT `services` — see the docstring
      // on `ClientTabs` in types.ts. Sharing the staff Work → Services
      // tab's value would cause BreadcrumbNav to render a
      // cross-role chip pairing the two, which is wrong: they're
      // unrelated tabs (client's subscribed services vs. operator's
      // job-recipe manager).
      value: "client-services",
      label: "Services",
      icon: FiClipboard,
      content: <ClientServicesTab />,
    },
    {
      // PUBLIC, like Community and Services above — no `visible` gate. The
      // people most worth showing an offer to are the ones who do not have
      // an account yet.
      //
      // Value is `client-promotions`, NOT `promotions`: the Money →
      // Promotions tab already owns that value, and sharing it makes
      // BreadcrumbNav pair the two as one cross-role tab. Same reason
      // Services is `client-services`. The deep link is unaffected — the
      // resolver matches on slugify(label), so `?tab=client-promotions`
      // still lands here.
      //
      // THAT URL IS PRINTED ON THINGS. A QR code on the wall display and on
      // signage points at `?tab=client-promotions`; renaming this label
      // breaks every code already out in the world.
      value: "client-promotions",
      label: "Promotions",
      icon: FiTag,
      content: <ClientPromotionsTab />,
    },
  ];

  // Clearance is a capability, not a pay class: isFieldCleared() asks
  // for `work.claim`.
  const notFieldCleared = !isFieldCleared(me);

  const workerTasks: TaskDef[] = [
    {
      id: "plan-route",
      label: "Plan Next Work Day",
      // Every route these two touch is OWNERSHIP, so the capability they
      // need is just "can you see the schedule at all". That used to be
      // implicit in the tab's own gate; it stopped being implicit when the
      // tab became reachable on `books.view` for the bookkeeper, who was
      // then offered a workday planner for work they do not do.
      requires: ["schedule.view"],
      description: notFieldCleared ? "View your upcoming job summary" : "Confirm your claimed jobs for tomorrow and notify clients",
      icon: FiNavigation,
      colorPalette: "blue",
      bgColor: "blue.faint",
      onClick: () => {
        if (notFieldCleared) {
          setConfirmAction({
            title: "Read only",
            message: "As a trainee, you can view your upcoming job summary but cannot confirm, release, or message clients. Contact your team lead to manage your schedule.",
            confirmLabel: "View Summary",
            colorPalette: "blue",
            onConfirm: () => launchWorkflow("plan-workday-readonly", { targetDate: bizTomorrow() }),
          });
        } else {
          launchWorkflow("plan-workday", { targetDate: bizTomorrow() });
        }
      },
    },
    {
      id: "start-day",
      label: "Prepare for Work Day",
      requires: ["schedule.view"],
      description: "Review today's schedule, confirm jobs, and start your first stop",
      icon: FiSun,
      colorPalette: "green",
      bgColor: "green.faint",
      onClick: () => {
        launchWorkflow("begin-workday");
      },
    },
  ];

  // Order matters: BreadcrumbNav derives the category list (and the inner-tab
  // list within each category) from the order tabs appear here. Keep tabs of
  // the same category contiguous, categories in the intended display order:
  // Work · Equipment · Directory · Money · Records · System.


  // HOISTED OUT OF `navTabs` so the SHELL can ask whether any of these is
  // visible. A shell used to appear only for a holder of its own surface
  // capability, which stranded anybody whose role lights none of the three:
  // a bookkeeper has tabs in this list and `settings.manage` in none of
  // their roles, so the tabs existed and there was no door to them.
  // THE tab list — one entry per feature.
  //
  // There were three: a worker copy, a manager copy and this one. Which
  // you got was decided by navigation, so the same feature rendered
  // three ways and a custom role received whichever build its shell
  // happened to light — a bookkeeper was shown a field worker's
  // Payments screen. This list already held all 37 tabs; the other two
  // were subsets mounting the same components differently.
  //
  // A tab appears if your entitlements open it (TAB_REQUIREMENTS) and
  // renders from those same entitlements. Both read the
  // PERSPECTIVE-NARROWED set, so taking a perspective narrows the tab
  // list AND the contents of every tab still in it.
  const staffTabs = withCapabilityVisibility([
        {
          // ── Work ──
          // Operations-pulse dashboard — money / jobs / equipment /
          // team / clients rollup for a rolling period ending today.
          // One period button drives every section. This is the staff
          // landing tab.
          value: "home",
          label: "Home",
          icon: FiHome,
          content: wrapWithInlineMessage(
            <HomeTab
              me={me}
              onLaunchWorkflow={() => {}}
              scope={scopeBase}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Jobs — same JobsTab as Admin+Worker, driven by scope so the
          // Management overlays appear (Client Requests, Ops
          // summary strip, cancel/reopen action row, etc.).
          value: "jobs",
          label: "Jobs",
          icon: FiClipboard,
          content: wrapWithInlineMessage(
            <JobsTab
              me={me}
             
              scope={scopeBase}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Routes — the same PreviewRoutesTab every shell mounts. Scope
          // brings the team-travel Operations panel to the top of the tab.
          value: "routes",
          label: "Routes",
          icon: FiNavigation,
          content: wrapWithInlineMessage(
            <PreviewRoutesTab scope={scopeBase} />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Services. Everything it offers gates on `schedule.view` /
          // `schedule.manage` inside the tab.
          value: "services",
          label: "Services",
          icon: FiBriefcase,
          content: wrapWithInlineMessage(
            <ServicesTab
              me={me}
             
              streamReviewOccId={streamReviewOccId}
              streamReviewNonce={streamReviewNonce}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Actions (+) — the task list. Each shortcut in it is gated on
          // the capability of the queue it opens.
          //
          // ONE LIST. `workerTasks` used to be mounted by the worker shell
          // and `staffTasks` by the other two; when the shells merged into
          // this single tab list, only `staffTasks` kept a mount point and
          // `workerTasks` became dead code — so the two workday workflows
          // disappeared for everyone, including the people they exist for,
          // while the setup and export cards appeared for every holder of
          // `schedule.view`. Concatenated here and filtered per entry by
          // `requires`, so what you see is your capabilities and not which
          // shell drew the page.
          //
          // Workday first: they are the daily ones, and they are what a
          // field worker opens this tab for.
          value: "tasks",
          label: "Actions",
          icon: FiPlus,
          content: (
            <TasksTab
              tasks={[...workerTasks, ...staffTasks]}
              scope={scopeBase}
              workerType={me?.workerType}
              // Never passed before, so the read-only note for somebody
              // without field clearance could not render.
              fieldCleared={!notFieldCleared}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // ── Equipment ──
          // Inventory. The act-on-behalf-of-worker controls (reserve /
          // cancel / checkout / return for a specific worker) are gated
          // inside the tab on `equipment.manage` — a fail-safe for when
          // somebody is stuck in the mobile flow and needs the action
          // driven remotely.
          //
          // Positioned right after Services so the Equipment category
          // sits IMMEDIATELY BELOW Work in the category strip.
          value: "equipment",
          label: "Inventory",
          icon: FiTool,
          content: wrapWithInlineMessage(
            <InventoryTab
              key={`seq-${equipmentRemountKey}`}
              me={me}
             
              scope={scopeBase}
            />
          ),
          category: "Equipment",
          categoryIcon: FiTool,
        },
        {
          // ── Equipment → Collections ──
          // CollectionsTab gates its authoring controls on
          // `equipment.manage` and its Insights strip (kits with issues,
          // availability, job coverage) on `reports.view`. Insights is
          // computed from the collections payload already fetched — no
          // extra server round-trip.
          value: "collections",
          label: "Collections",
          icon: FiPackage,
          content: wrapWithInlineMessage(
            <CollectionsTab
              scope={scopeBase}
            />
          ),
          category: "Equipment",
          categoryIcon: FiTool,
        },
        {
          // ── Equipment → Vehicles ──
          // Dual-use vehicle fleet: manage vehicles, assignments (which
          // workers can log mileage against which vehicle), and the
          // per-vehicle mileage log. See services/vehicles.ts and
          // services/mileage.ts for the backend contracts and the
          // MileageStrip on the worker HomeTab for the driver-side flow.
          value: "vehicles",
          label: "Vehicles",
          icon: FiTruck,
          content: wrapWithInlineMessage(
            <VehiclesTab
              scope={scopeBase}
            />
          ),
          category: "Equipment",
          categoryIcon: FiTool,
        },
        {
          // ── Directory ── (Clients → Properties → Users → Groups)
          // Clients. The "View as this client" button is gated inside the
          // tab on `clients.view-as`, which is also the guard on the
          // impersonation routes. There used to be two Clients mounts —
          // someone with `schedule.manage` one and someone with `settings.manage` one — and the button was rendered
          // only on the second; it is one tab and one capability now.
          value: "clients",
          label: "Clients",
          icon: FiUsers,
          content: wrapWithInlineMessage(
            <ClientsTab
              me={me}
             
              scope={scopeBase}
            />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Properties. The tab reads `clients.view` for the list and
          // `clients.manage` for CRUD, the photos manager and delete.
          value: "properties",
          label: "Properties",
          icon: FiMapPin,
          content: wrapWithInlineMessage(
            <PropertiesTab
              me={me}
             
              scope={scopeBase}
            />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Portfolios — the place tree, and who looks after each branch. A role
          // held in a portfolio is the same role, confined to it.
          //
          // DIRECTORY, NOT SYSTEM. An Portfolio is a named grouping of
          // PROPERTIES, which is the same shape of thing as a Group (a
          // named grouping of people) sitting two rows below. The page is
          // mostly a name, a tier, a centre point and "Properties in X" —
          // record maintenance, not configuration — and "which properties
          // are in Pittsboro?" is a question nobody takes to System. The
          // assignment panel stays on the tab; a category is navigation,
          // and `portfolios.manage` still guards every mutation on it.
          value: "portfolios",
          label: "Portfolios",
          // LAYERS, NOT A PIN. Properties two rows up already uses FiMapPin
          // and the two tabs sat side by side in Directory wearing the same
          // glyph. The pin belongs to Properties — a property IS a place.
          // A portfolio is a nested GROUPING that need not be a place at
          // all, which is what the stacked layers say.
          icon: FiLayers,
          content: wrapWithInlineMessage(
            <PortfoliosTab
              scope={scopeBase}
            />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Users. One directory: UsersTab renders the trimmed Team
          // roster without `people.manage`, the full directory with it,
          // and gates approving on `people.approve` and the role picker
          // on `people.grant-roles` separately. This was a second,
          // writable mount sitting beside a read-only admin one.
          // The "Pending Users" alert chip in the title bar routes here.
          value: "users",
          label: "Users",
          icon: AiOutlineTeam,
          content: wrapWithInlineMessage(
            <UsersTab scope={scopeBase} />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Groups — the same CrewsTab holders of `schedule.manage` see. Groups (crews)
          // are managed at the management tier, but the top tier also needs the
          // surface for support debugging + cross-role parity.
          value: "groups",
          label: "Groups",
          icon: AiOutlineTeam,
          content: wrapWithInlineMessage(
            <CrewsTab scope={scopeBase} />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // ── Money ── (Super sub-tab order: Payments → Payroll →
          // Ledger → Pricing → Supplies → Promotions → Forecast.
          //
          // The first three are the money-movement surfaces — what came
          // in, what went out to people, what went out everywhere else —
          // so they sit together; Pricing and Supplies are configuration
          // rather than record-keeping and follow.
          //
          // Forecast sits LAST — it is the only surface here that reports
          // nothing that happened. Everything above it is a record or a
          // setting; Forecast is advisory, writes no setting and pays nobody,
          // so it reads as the thing you do after the rest rather than
          // another ledger.
          //
          // Every tab in this category is one tab. Which of them appear
          // for a given reader is TAB_REQUIREMENTS: Payments `money.view`,
          // Payroll `payroll.view`, Ledger `books.view`, Pricing
          // `pricing.view`, Forecast `forecasts.view`, Promotions
          // `marketing.campaigns`.)
          value: "payments",
          label: "Payments",
          icon: TfiMoney,
          content: wrapWithInlineMessage(<PaymentsTab me={me} scope={scopeBase} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          // `payroll.view` opens it; `payroll.manage` adds upload,
          // identity matching and archive. Both are read inside the tab.
          value: "payroll",
          label: "Payroll",
          icon: Banknote,
          content: wrapWithInlineMessage(<PayrollTab me={me} scope={scopeBase} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          // Internally this tab is BusinessExpensesTab and the API/model
          // is BusinessExpense — both kept for historical reasons. The
          // visible label is "Ledger" because the tab is a hand-logged
          // record of three money-movement categories: business expenses,
          // capital contributions (equity in), and owner draws (equity
          // out). See the EntryType discriminator on the BusinessExpense
          // model. The URL key is "ledger" to match the visible name —
          // deep links and localStorage handoffs (Supply badge, Job badge)
          // need updating to match.
          //
          // `books.view` — it is not mounted for anyone without it.
          value: "ledger",
          label: "Ledger",
          icon: FiBook,
          content: wrapWithInlineMessage(<BusinessExpensesTab scope={scopeBase} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          value: "pricing",
          label: "Pricing",
          icon: FiTag,
          content: wrapWithInlineMessage(<PricingTab scope={scopeBase} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          value: "supplies",
          label: "Supplies",
          icon: FiPackage,
          content: wrapWithInlineMessage(<SuppliesTab scope={scopeBase} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          // Promotions — `marketing.campaigns`. Campaigns piggyback on
          // outgoing invoice comms (or blast manually), with full audit
          // trail and per-contact opt-out. See PromotionsTab +
          // services/promotions.ts.
          value: "promotions",
          label: "Promotions",
          icon: FiSpeaker,
          content: wrapWithInlineMessage(<PromotionsTab />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        // NOTE: Reconcile moved out of Money → Records. It lives next to
        // Workdays / Audit / Timeline now since it's an external-system
        // reconciliation surface rather than a per-record money editor.
        {
          // ── Records ── (audit / review surfaces — placed between
          // Money and Tools so the top-level category order matches
          // Work → Equipment → Directory → Money → Records → Tools
          // → System.)
          // Reconcile — accounting-software validation surface. Replaces
          // the old Exports + P&L Report tabs. Renders a QB-style P&L
          // for the selected window with click-to-drill-down on every
          // row, and offers flat CSVs (Capital, Income, Expenses,
          // Workdays) for visual cross-checking against the operator's
          // accounting software (which is now the source of truth, wired
          // directly to the bank). See ReconcileTab.tsx + services/
          // pnlReport.ts + services/exports.ts.
          value: "reconcile",
          label: "Reconcile",
          icon: FiBarChart2,
          content: wrapWithInlineMessage(<ReconcileTab scope={scopeBase} />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Workdays — the review queue for per-worker clock-in/out.
          // Opens on `time.view` or `time.manage`; approving each row is
          // `time.approve`. Day-paged; the 4 AM ET cutoff (settings-driven)
          // gates the approval actions. See ui/tabs/WorkdaysTab.tsx +
          // services/workdays.ts.
          value: "workdays",
          label: "Workdays",
          icon: FiClock,
          content: wrapWithInlineMessage(
            <WorkdaysTab
              pendingByDate={pendingWorkdaysByDate}
              initialDate={workdaysJumpDate}
              jumpNonce={workdaysJumpNonce}
              onApprovalsChanged={() => void loadPendingWorkdaysRef.current()}
            />,
          ),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Compliance — admin surface for the PolicyDocument system.
          // Placed under Records right after Workdays so both worker-
          // gate surfaces (hours + policy signatures) sit side-by-side.
          value: "compliance",
          label: "Compliance",
          icon: FiUserCheck,
          content: wrapWithInlineMessage(<ComplianceTab />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Engagement — same ActivityTab holders of `schedule.manage` see. Surfaced under
          // Super Records for parity with Admin's Records sub-tabs.
          value: "activity",
          label: "Engagement",
          icon: FiActivity,
          content: wrapWithInlineMessage(<ActivityTab scope={scopeBase} />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // History — same HistoryTab holders of `schedule.manage` see. Same rationale as
          // Engagement above.
          value: "history",
          label: "History",
          icon: FiFileText,
          content: wrapWithInlineMessage(<HistoryTab scope={scopeBase} />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          value: "timeline",
          label: "Timeline",
          icon: FiCalendar,
          content: wrapWithInlineMessage(<TimelineTab scope={scopeBase} />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          value: "documents",
          label: "Documents",
          icon: FiFolder,
          content: wrapWithInlineMessage(<DocumentsTab scope={scopeBase} />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Education guides — see docs/features/education.md. The `content.approve` holder is the
          // only role that approves content or touches video.
          value: "guides",
          label: "Guides",
          icon: FiBookOpen,
          content: wrapWithInlineMessage(
            <GuidesTab
              me={me}
             
              scope={scopeBase}
            />,
          ),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          value: "audit",
          label: "Audit",
          icon: FiSearch,
          content: <AuditTab />,
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // ── Insights ── ANALYSIS, NOT TRANSACTIONS.
          //
          // Two reports that interpret rather than record: Statistics looks
          // backward at what happened, Forecast forward at what might.
          // Neither writes anything, which is what separates them from
          // Payments and the Ledger.
          //
          // CATEGORY ORDER IS DECLARATION ORDER in this array, so this run
          // sits after the last Records tab and before Tools:
          // Work → Equipment → Directory → Money → Records → Insights →
          // Tools → System. Declaring a tab inside another category's run
          // splits that category and the nav shows it twice — which is
          // exactly what happened when Statistics was first added among the
          // Money tabs.
          value: "statistics",
          label: "Statistics",
          // BARS, because that is what the page draws — TEAM COMPARISON is
          // a bar per person. The category keeps LineChart and Forecast
          // takes TrendingUp; all three were LineChart at first, so the
          // chip and both its tabs were the same glyph.
          icon: BarChart3,
          content: wrapWithInlineMessage(<StatisticsTab scope={scopeBase} />),
          category: "Insights",
          categoryIcon: LineChart,
        },
        {
          // Pay-structure simulator — `forecasts.view`. Deliberately NOT
          // part of Reconcile or the P&L: those report what happened, this
          // asks what should change. Keeping them separate stops a
          // projection from ever being mistaken for a record.
          value: "forecast",
          label: "Forecast",
          // An arrow going up and to the right — it projects forward, which
          // is the distinction from Statistics beside it.
          icon: TrendingUp,
          content: wrapWithInlineMessage(<ForecastTab />),
          category: "Insights",
          categoryIcon: LineChart,
        },
        {
          // ── Tools ──
          // Read-only calculators and estimating helpers. Each tool is its
          // own third-level tab under the shared "Tools" category — add
          // additional tools by appending sibling entries with the same
          // category. The tool components live in apps/web/src/ui/tools/
          // and are self-contained from the rest of the app (pull existing
          // settings but never mutate).
          value: "tools-mowing",
          label: "Mowing",
          icon: FiTool,
          content: wrapWithInlineMessage(<MowingJobTool />),
          category: "Tools",
          categoryIcon: FiTool,
        },
        {
          value: "tools-mulch",
          label: "Mulch",
          icon: FiTool,
          content: wrapWithInlineMessage(<MulchJobTool />),
          category: "Tools",
          categoryIcon: FiTool,
        },
        {
          // ── System ── (order: Profile → Notify → Vanity → Settings)
          value: "profile",
          label: "Profile",
          icon: FiUser,
          content: wrapWithInlineMessage(<ProfileTab me={me} onProfileUpdated={refreshMe} />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          // Notify — the same NotifyTab mounted elsewhere, here for parity
          // with the System sub-tab list.
          value: "notify",
          label: "Notify",
          icon: FiBell,
          content: wrapWithInlineMessage(<NotifyTab />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          // Roles — define what a role grants, and see every role against
          // every capability. Appears for `roles.view`; editing needs
          // `roles.define`, which the tab checks itself. Until this
          // existed, roles could only be created by running a script.
          value: "roles",
          label: "Roles",
          icon: FiShield,
          content: wrapWithInlineMessage(
            <RolesTab
              scope={scopeBase}
            />
          ),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          // Vanity — `marketing.campaigns`. Editor for branded shortcuts on
          // seedlings.pro. Each row is either a landing page (renders
          // in-app) or a redirect (302 to a configured URL). One row
          // is flagged as default and serves as the fallback for
          // unknown slugs. See VanityUrlsTab + services/vanityPages.ts.
          value: "vanity",
          label: "Vanity",
          icon: FiLink,
          content: wrapWithInlineMessage(<VanityUrlsTab />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          // Displays — wall screens showing a live board. Its own tab rather
          // than a section inside Settings because of the pairing moment:
          // you are standing at the screen with a code counting down and a
          // phone in your hand, so it has to be one tap from the breadcrumb.
          // See DisplaysTab + services/displays.ts + the Display model.
          value: "displays",
          label: "Displays",
          icon: FiMonitor,
          content: wrapWithInlineMessage(<DisplaysTab />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          value: "settings",
          label: "Settings",
          icon: FiSettings,
          content: wrapWithInlineMessage(<SettingsTab me={me} />),
          category: "System",
          categoryIcon: FiSettings,
        },
  ]);

  const navTabs: import("@/src/ui/components/BreadcrumbNav").OuterTab[] = [
    {
      value: "client",
      label: "Client",
      icon: FiHome,
      visible: true,
      innerTabs: clientTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content })),
    },
    {
      // ONE STAFF SHELL.
      //
      // There were three — My Work, Operations, Business — and the one you
      // were in chose both the tab list and the build of each tab. Role
      // switching is a PERSPECTIVE now, which narrows what you hold; it is
      // not a different set of screens.
      value: "staff",
      label: "Work",
      icon: FiUser,
      visible: () => !!isSignedIn && !!me?.isApproved && anyTabVisible(staffTabs),
      headerSlot: (
        <>
          {me && !me.workerType && (
            <Box mb={2} p={3} bg="orange.faint" borderWidth="1px" borderColor="orange.emphasized" rounded="md">
              <HStack gap={2} align="start">
                <Box flexShrink={0} pt="0.5"><AlertTriangle size={14} color="var(--chakra-colors-orange-500)" /></Box>
                <Text fontSize="sm" color="orange.fg">
                  Your worker type has not been assigned yet. Some features may be restricted until assigned by your administrator.
                </Text>
              </HStack>
            </Box>
          )}
          {/* `schedule.view` as well as the clearance check: this explains
              what you cannot do to VISITS, which is not news to somebody
              who cannot see visits in the first place. The bookkeeper was
              being told to ask their team manager about claiming jobs.

              THE WORDING IS LOAD-BEARING AND WAS WRONG TWICE OVER.
              It opened "You are not cleared for field work yet", which
              reads as "you do not do field work". A trainee is an ordinary
              EMPLOYEE; field clearance is three entitlements —
              `work.claim`, `work.complete`, `inventory.pull` — so what
              they lack is the ability to pick up or run a visit
              THEMSELVES, not the work.

              SAY NOTHING ABOUT PAY HERE. A draft read "you are paid for it
              the same as anyone else", meaning "this is real work, not an
              unpaid trial" — but it reads as a promise of the same HOURLY
              RATE, which is a per-person fact this banner cannot know and
              has no business asserting. Wage lives in payroll; a
              capability notice should describe capabilities.
              The "you only see what you are assigned to" clause is TRUE
              and was briefly deleted on a bad measurement: `/api/clients`
              returns all 16 rows to a trainee, which looked like the
              banner was lying, but ClientsTab narrows them to the
              assigned set and renders 4. Counting an API payload is not
              counting what somebody sees. (The over-return is still real
              and still worth closing at the endpoint — it is visible to
              anyone who opens devtools — but it is not what this sentence
              is about.)

              SHORTENED 2026-10-26 — it ran to six lines on a phone, above
              the content it was explaining. All three facts survive: you do
              work visits, the four things you cannot do yourself and who to
              ask, and that your lists are narrowed. What went is the
              restatement — "visits, clients and properties" for "what", and
              the "what you cannot do yet is" scaffolding. Phrase it as what
              to DO rather than a list of refusals; if you add a fourth
              clause, take one out. */}
          {/* NOT FOR AN OVERSIGHT READER. The sentence says "you only see
              those", which stopped being true for anybody holding
              `schedule.view-all`: they are not field-cleared and never will
              be, and they now see the whole board. Leaving it up told a
              bookkeeper their empty-looking list was a permission limit
              when it was not. */}
          {notFieldCleared && scopeCan("schedule.view")
            && !scopeCan("schedule.view-all") && (
            <Box mb={2} p={{ base: 2, md: 3 }} bg="blue.faint" borderWidth="1px" borderColor="blue.emphasized" rounded="md">
              <HStack gap={2} align="start">
                <Box flexShrink={0} pt="0.5"><AlertTriangle size={14} color="var(--chakra-colors-blue-500)" /></Box>
                <Text fontSize="sm" color="blue.fg">
                  You can work visits you are assigned to, and only see those. Ask your team manager to pick up, start or finish a visit, or reserve equipment.
                </Text>
              </HStack>
            </Box>
          )}
          {/* Contractor-insurance banner removed with the compliance-policy
              migration. Slice 2 adds a general "N compliance items pending"
              banner sourced from GET /me/policies that covers insurance,
              W-9, safety SOP, and every other configured policy. */}
          <PlanWorkdayWorkflow
            active={activeWorkflow === "plan-workday" || activeWorkflow === "plan-workday-readonly"}
            onDone={() => setActiveWorkflow(null)}
            myId={me?.id}
            defaultTargetDate={planWorkdayDate ?? undefined}
            readOnly={activeWorkflow === "plan-workday-readonly"}
          />
          <BeginWorkDayWorkflow
            active={activeWorkflow === "begin-workday"}
            onDone={() => setActiveWorkflow(null)}
            myId={me?.id}
            myWorkerType={me?.workerType ?? null}
          />
          {pausedWorkflow && !(
            (workflowOrigin?.outer ?? "worker") === topTab &&
            (workflowOrigin?.inner ?? "tasks") === staffInnerTab
          ) && (
            <Box
              mb={3} p={4} rounded="lg"
              display="flex" justifyContent="space-between" alignItems="center" gap={3}
              flexWrap="wrap"
              style={{
                background: pausedWorkflow === "begin-workday"
                  ? "linear-gradient(135deg, #38a169 0%, #2f855a 100%)"
                  : "linear-gradient(135deg, #3182ce 0%, #2b6cb0 100%)",
                border: pausedWorkflow === "begin-workday" ? "2px solid #276749" : "2px solid #2c5282",
                boxShadow: pausedWorkflow === "begin-workday"
                  ? "0 2px 8px rgba(56, 161, 105, 0.3)"
                  : "0 2px 8px rgba(49, 130, 206, 0.3)",
              }}
            >
              <Text fontSize="sm" fontWeight="semibold" color="white">
                {pausedWorkflow === "begin-workday"
                  ? "You're in the Prepare for Work Day workflow. Return when you're done here."
                  : "You're in the Plan Workday workflow. Return when you're done here."}
              </Text>
              <Button
                size="sm"
                flexShrink={0}
                style={{
                  background: "white",
                  color: pausedWorkflow === "begin-workday" ? "#2f855a" : "#2b6cb0",
                  fontWeight: 700,
                }}
                onClick={() => {
                  try {
                    localStorage.removeItem("seedlings_planWorkday_paused");
                    localStorage.removeItem("seedlings_beginWorkday_paused");
                  } catch {}
                  setPausedWorkflow(null);
                  // Land on whichever tab launched this workflow. The old
                  // hardcoded "tasks" meant a workflow started from Home
                  // dumped you on +Actions after any step that links out.
                  // Falls back to staff/tasks when no origin was recorded
                  // (older paused state, or a write that failed). The
                  // fallback said `outer: "worker"`, a shell that no longer
                  // exists — applyNavState would have set topTab to it and
                  // the migration would have coerced it back to "staff".
                  applyNavState(workflowOrigin ?? { outer: "staff", inner: "tasks", category: "Work" });
                  // trigger:workflow resumes WITHOUT re-recording an origin —
                  // see launchWorkflow.
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent("trigger:workflow", { detail: { id: pausedWorkflow } }));
                  }, 100);
                }}
              >
                Return to Workflow
              </Button>
            </Box>
          )}
        </>
      ),
      innerTabs: staffTabs,
    },
  ];

  // Header-mounted role switcher — replaces the outer role pill that used
  // to lead the BreadcrumbNav. Computed from navTabs' visibility
  // functions so a single source of truth (the tab-tree) drives BOTH the
  // rendered chrome and the switcher options. There are two shells now,
  // `client` and `staff`; which TABS are on the staff one is decided by
  // TAB_REQUIREMENTS, not by a role.
  const availableRoles = navTabs
    .filter((t) => (typeof t.visible === "function" ? t.visible() : t.visible !== false))
    .map((t) => ({ value: t.value as RoleValue, label: t.label, icon: t.icon }));

  // Switch role while preserving the current inner tab when the same tab
  // value exists in the target role. When it doesn't, we leave the target
  // role's persisted inner tab alone — that's normally the role's own
  // last-viewed tab or its default landing. Also pushes nav history so the
  // back button retraces the role switch.
  function switchRole(newRole: "client" | "staff") {
    if (newRole === topTab) return;
    // DELIBERATE, so the rescue below must not undo it. A staff member may
    // sit on the customer portal to look at the public side — Community,
    // Services and Promotions render for anybody. Without this marker the
    // reconciliation effect reads "staff account on the client shell" as
    // somebody stranded and bounces them straight back, so the menu entry
    // appears to do nothing.
    setShellChosen(true);
    const currentInner = topTab === "client" ? clientInnerTab : staffInnerTab;
    const targetRoleTabs = navTabs.find((n) => n.value === newRole)?.innerTabs ?? [];
    const equivalent = targetRoleTabs.find(
      (t) => t.value === currentInner
        && (typeof t.visible === "function" ? t.visible() : t.visible !== false),
    );
    pushNavHistory(getCurrentNavState());
    if (equivalent) {
      if (newRole === "client") setClientInnerTab(equivalent.value as ClientTabs);
      else setStaffInnerTab(equivalent.value as StaffTabs);
    }
    setTopTab(newRole);
  }

  // ONE destination per event. This took either a shared tab id or an
  // `{ admin, worker }` pair, because the same feature lived on two tabs
  // and a search result had to be routed to the right copy. There is one
  // copy now, so there is one destination.
  const setupSearchEvent = (eventName: EventTypes, tabName: StaffTabs) => {
    const target: StaffTabs = tabName;
    useEffect(() => {
      if (typeof window === "undefined") return;
      const onEvent = (e: Event) => {
        const { q, entityId } = (e as CustomEvent).detail || {};
        if (!q && !entityId) return;
        pushNavHistory(getCurrentNavState());
        setTopTab("staff");
        setStaffInnerTab(target);
        window.sessionStorage.setItem(
          `open:${eventName}Once`,
          JSON.stringify({ q, entityId }),
        );
      };
      window.addEventListener(`open:${eventName}`, onEvent as EventListener);
      return () =>
        window.removeEventListener(
          `open:${eventName}`,
          onEvent as EventListener
        );
    }, []);
    useEffect(() => {
      if (typeof window === "undefined") return;
      const key = `open:${eventName}Once`;
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return;
      let payload: { q: string; entityId?: string };
      try { payload = JSON.parse(raw); } catch { payload = { q: raw }; }
      window.sessionStorage.removeItem(key);
      // Use setTimeout to allow target tab to mount before dispatching
      const timer = setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(`${eventName}:run`, { detail: payload })
        );
      }, 150);
      return () => clearTimeout(timer);
    }, [topTab, staffInnerTab, staffInnerTab]);
  };

  setupSearchEvent("clientTabToPropertiesTabSearch", "properties");
  setupSearchEvent("propertyTabToClientTabSearch", "clients");
  setupSearchEvent("propertyTabToClientTabContactSearch", "clients");
  setupSearchEvent("activityTavToEquipmentTabQRCodeSearch", "equipment");
  setupSearchEvent("jobsToEquipmentKindFilter", "equipment");
  setupSearchEvent("jobsTabToPropertiesTabSearch", "properties");
  setupSearchEvent("jobsTabToClientsTabSearch", "clients");
  setupSearchEvent("paymentsTabToPropertiesTabSearch", "properties");
  // Portfolios → Properties. The Portfolios tab lists a portfolio's properties; clicking
  // one should land on it, not leave you to search for it by hand.
  setupSearchEvent("areasTabToPropertiesTabSearch", "properties");
  setupSearchEvent("paymentsTabToClientsTabSearch", "clients");
  // jobsTabToServicesTabSearch — "Manage in Services" button on the
  // JobsTab occurrence card. The `:run` handler lives in ServicesTab
  // (see ServicesTab.tsx), so we must route to the "services" tab so
  // that handler is actually mounted when the event fires. A previous
  // change routed this to "jobs" which silently broke the button.
  setupSearchEvent("jobsTabToServicesTabSearch", "services");
  // clientsTabToServicesTabSearch — the "Job services" button on the
  // ClientsTab card (which also carries the paused-repeating count).
  // Routes to Services; ServicesTab's :run listener sets q to the
  // client's displayName and clears the status filter — the operator came
  // to pause or resume a repeating service, so the running ones are
  // exactly what they need to see.
  setupSearchEvent("clientsTabToServicesTabSearch", "services");

  // Payments "Job" link → Jobs tab, highlighted to the exact occurrence the
  // payment was recorded against. We send the OCCURRENCE id (plus its
  // startAt for the date anchor) so JobsTab's existing
  // `jobsTab:highlightOcc` handler can call `applyHighlight()` and narrow
  // the view to a single row — much more useful than filtering to the job
  // (which would show every recurring occurrence of that job).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onEvent = (e: Event) => {
      const { entityId, anchorAt } = (e as CustomEvent).detail || {};
      if (!entityId) return;
      pushNavHistory(getCurrentNavState());
      // One Jobs tab. This was a two-arm branch on a role flag with two
      // identical bodies, left over from the two-shell split.
      setTopTab("staff");
      setStaffInnerTab("jobs");
      window.sessionStorage.setItem(
        "paymentsTabToJobsNav",
        JSON.stringify({ occId: entityId, anchorAt: anchorAt ?? null }),
      );
    };
    window.addEventListener("open:paymentsTabToJobsTabSearch", onEvent as EventListener);
    return () => window.removeEventListener("open:paymentsTabToJobsTabSearch", onEvent as EventListener);
  }, []);

  // Client-portal shortcut: banner on My Properties → jump to the
  // Statements tab in the client dropdown. Kept as a window event so
  // the child tab component doesn't need to prop-drill the setter.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onEvent = () => setClientInnerTab("statements");
    window.addEventListener("open:clientStatementsTab", onEvent as EventListener);
    return () => window.removeEventListener("open:clientStatementsTab", onEvent as EventListener);
  }, [setClientInnerTab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // One Jobs tab now, so one check.
    if (topTab !== "staff" || staffInnerTab !== "jobs") return;
    const raw = window.sessionStorage.getItem("paymentsTabToJobsNav");
    if (!raw) return;
    window.sessionStorage.removeItem("paymentsTabToJobsNav");
    let payload: { occId: string; anchorAt: string | null };
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload?.occId) return;
    // Wait for JobsTab to mount and signal ready, same pattern as
    // servicesTabToJobsTabSearch above. Caps attempts so a never-ready
    // tab doesn't hang the relay.
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__jobsTabReady || attempts >= 30) {
        clearInterval(interval);
        window.dispatchEvent(
          new CustomEvent("jobsTab:highlightOcc", { detail: { occId: payload.occId, anchorAt: payload.anchorAt } }),
        );
      }
    }, 100);
    return () => clearInterval(interval);
  }, [topTab, staffInnerTab, staffInnerTab]);

  // Generic tab switcher (used by Audit tab and others to navigate across top-level tabs)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onSwitch = (e: Event) => {
      const { outer, inner } = (e as CustomEvent).detail || {};
      if (outer) setTopTab(outer);
      if (inner && outer === "admin") setStaffInnerTab(inner);
      if (inner && outer === "worker") setStaffInnerTab(inner);
      if (inner && outer === "super") setStaffInnerTab(inner);
    };
    window.addEventListener("seedlings:switchTab", onSwitch as EventListener);
    return () => window.removeEventListener("seedlings:switchTab", onSwitch as EventListener);
  }, []);

  // Services → Admin Jobs (special: targets "jobs" inner tab)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onEvent = (e: Event) => {
      const { entityId } = (e as CustomEvent).detail || {};
      if (!entityId) return;
      setTopTab("staff");
      setStaffInnerTab("jobs");
      window.sessionStorage.setItem("servicesTabToJobsNav", entityId);
    };
    window.addEventListener("open:servicesTabToJobsTabSearch", onEvent as EventListener);
    return () => window.removeEventListener("open:servicesTabToJobsTabSearch", onEvent as EventListener);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (staffInnerTab !== "jobs") return;
    const entityId = window.sessionStorage.getItem("servicesTabToJobsNav");
    if (!entityId) return;
    window.sessionStorage.removeItem("servicesTabToJobsNav");
    // Wait for JobsTab to mount then dispatch highlight
    const sepIdx = entityId.indexOf("|");
    const occId = sepIdx >= 0 ? entityId.slice(0, sepIdx) : entityId;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__jobsTabReady || attempts >= 30) {
        clearInterval(interval);
        window.dispatchEvent(new CustomEvent("jobsTab:highlightOcc", { detail: { occId } }));
      }
    }, 100);
    return () => clearInterval(interval);
  }, [topTab, staffInnerTab]);


  useEffect(() => {
    if (typeof window === "undefined") return;
    if (topTab !== "staff" || staffInnerTab !== "users") return;

    const key = "users:openOnce";
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;

    requestAnimationFrame(() => {
      try {
        const detail = JSON.parse(raw) as {
          status: "pending" | "approved" | "all";
        };
        window.dispatchEvent(
          new CustomEvent("seedlings3:open-users", { detail })
        );
      } finally {
        window.sessionStorage.removeItem(key);
      }
    });
  }, [topTab, staffInnerTab]);

  const BRAND_ICON_H = 34; // px

  // Earnings shown in the title bar (replaced the weather toggle).
  // Click cycles through Today → Week → Month → All Time.
  // To revert: restore the prior `currentTemp` + `weatherBarVisible` state from git
  // and the Cloud icon button below.
  type EarningsPeriod = "today" | "thisWeek" | "thisMonth" | "allTime";
  // Cycle only walks Today → Week → Month. "allTime" is intentionally
  // omitted — management views show this number; an unbounded "All"
  // running total stops being useful past a month.
  const EARNINGS_PERIODS: EarningsPeriod[] = ["today", "thisWeek", "thisMonth"];
  const EARNINGS_LABELS: Record<EarningsPeriod, string> = { today: "Today", thisWeek: "Wk", thisMonth: "Mo", allTime: "All" };
  const [earnings, setEarnings] = useState<{ today: number; thisWeek: number; thisMonth: number; allTime: number } | null>(null);
  const [earningsPeriod, setEarningsPeriod] = usePersistedState<EarningsPeriod>("titleEarningsPeriod", "thisWeek");

  // Title-bar weather chip + bar visibility.
  // Click cycle: hidden → collapsed → expanded → hidden. Persisted so the
  // user's chosen state survives reloads. WeatherBar is still mounted in
  // hidden mode so its fetch continues running and broadcasts current temp.
  const [weatherMode, setWeatherMode] = usePersistedState<WeatherBarMode>("titleWeatherMode", "hidden");
  // The header drawer (the chevron at the end of the control strip).
  // PERSISTED, because somebody who wants the trophy to hand should not
  // re-open a drawer on every navigation — and closed by default, because
  // the whole point of the drawer is that the bar is shorter without it.
  const [headerDrawerOpen, setHeaderDrawerOpen] = usePersistedState<boolean>("headerDrawerOpen", false);
  const [titleWeather, setTitleWeather] = useState<{ temp: number; icon: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const cached = (window as any).__seedlingsWeather?.current;
    return cached ? { temp: cached.temp, icon: cached.icon } : null;
  });
  // Severe-weather alerts ride along on the same broadcast. Kept in its own
  // state so a payload without them leaves the temperature chip untouched.
  const [titleAlerts, setTitleAlerts] = useState<WeatherAlert[]>([]);
  useEffect(() => {
    function onWeather(e: any) {
      const d = e?.detail;
      if (d && typeof d.temp === "number" && typeof d.icon === "string") {
        setTitleWeather({ temp: d.temp, icon: d.icon });
      }
      if (d && Array.isArray(d.alerts)) setTitleAlerts(d.alerts);
    }
    window.addEventListener("seedlings:weather", onWeather);
    return () => window.removeEventListener("seedlings:weather", onWeather);
  }, []);
  function cycleWeatherMode() {
    setWeatherMode((m) => m === "hidden" ? "collapsed" : m === "collapsed" ? "expanded" : "hidden");
  }
  // Legacy migration: anyone with "allTime" persisted in localStorage from
  // when the cycle included it gets bumped back to "thisWeek" on next load.
  useEffect(() => {
    if (!EARNINGS_PERIODS.includes(earningsPeriod)) {
      setEarningsPeriod("thisWeek");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!isSignedIn || !me?.id) return;
    // Skip while someone with `settings.manage` is in a client view-as session. The /api/me
    // overlay makes `me` look client-shaped (empty roles, client
    // display name), but the earnings fetch would still go out under
    // the CALLER's real Clerk token — the server would happily return
    // the caller's OWN earnings, which the pill would then render on
    // top of the view-as shell. That misrepresents what the client
    // actually sees and can leak the operator's own numbers over the
    // client preview. The pill also has no place in a client view;
    // real clients aren't authorized on the underlying endpoint.
    if (me.isClientImpersonating) return;
    // Skip for pure client accounts (no staff) — the
    // endpoint is staff-only and would just 403 in a loop.
    if (!hasAnyRole) return;
    // Dedicated endpoint for the title-bar money chip — NOT the same one
    // ProfileTab uses (/api/payments/earnings-summary). Keeping them
    // separate so changes to ProfileTab's stats or admin Payments-tab
    // aggregations can't bleed into the title bar logic.
    let cancelled = false;
    const fetchEarnings = () => {
      apiGet<{ today: number; thisWeek: number; thisMonth: number; allTime: number }>("/api/payments/title-bar-earnings")
        .then((d) => {
          if (cancelled) return;
          setEarnings({ today: d?.today ?? 0, thisWeek: d?.thisWeek ?? 0, thisMonth: d?.thisMonth ?? 0, allTime: d?.allTime ?? 0 });
        })
        .catch(() => {});
    };
    fetchEarnings();
    // Worker self-actions that mutate their own earnings dispatch a
    // "seedlings:earnings-changed" event; we re-fetch on every emit.
    // Admin actions on other users don't dispatch — those users see
    // fresh numbers next page load, which is acceptable.
    const onEarningsChanged = () => fetchEarnings();
    window.addEventListener("seedlings:earnings-changed", onEarningsChanged);
    // Re-fetch when the tab regains focus, so a worker who switches
    // away and comes back sees current numbers without a hard refresh.
    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchEarnings();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("seedlings:earnings-changed", onEarningsChanged);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isSignedIn, me?.id, hasAnyRole]);
  function fmtEarnings(n: number): string {
    if (n >= 100000) return `${Math.round(n / 1000)}k`;
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function cycleEarningsPeriod() {
    const idx = EARNINGS_PERIODS.indexOf(earningsPeriod);
    setEarningsPeriod(EARNINGS_PERIODS[(idx + 1) % EARNINGS_PERIODS.length]);
  }

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // On-the-clock UI swap: when the workday is IN_PROGRESS or PAUSED, the
  // on-clock bubble takes the brand text's spot (leaf icon stays for the
  // navigate-home tap target). Frees the right side of the header from
  // an extra chip. See OnClockBubble.onActiveChange.
  const [onClockActive, setOnClockActive] = useState(false);

  // ---- Pending approvals badge (`money.approve`) ----
  // User-management is someone with `settings.manage` activity now — holders of `schedule.manage` see the directory
  // read-only and don't need a pending count. Loader bails for non-super
  // so we don't spend an API call we won't render.
  const [pending, setPending] = useState<number>(0);

  const loadPending = useCallback(async () => {
    // TWO capabilities, deliberately. The badge exists so somebody can
    // ADMIT a pending sign-up (`people.approve`), and the count it shows
    // comes from `/users/pendingCount` (`people.view`). Requiring both
    // means it is neither a number nobody can act on nor a request that
    // refuses. It was gated on `settings.manage`, which is
    // unrelated to either.
    if (!scopeCan("people.approve") || !scopeCan("people.view")) {
      setPending(0);
      markAlertLoaded("pending");
      return;
    }
    try {
      const res = await apiGet<{ pending: number }>(
        "/api/users/pendingCount"
      );
      setPending(res?.pending ?? 0);
    } catch {
      setPending(0);
    }
    markAlertLoaded("pending");
  }, [scopeCan]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  // ---- Pending payment approvals badge (admin + super) ----
  const [pendingPayments, setPendingPayments] = useState<number>(0);

  const loadPendingPayments = useCallback(async () => {
    // Same shape: approving is `money.approve`, the count is
    // `/payments/pending` (`money.view`).
    if (!scopeCan("money.approve") || !scopeCan("money.view")) {
      setPendingPayments(0);
      markAlertLoaded("pendingPayments");
      return;
    }
    try {
      const list = await apiGet<unknown[]>("/api/payments/pending");
      setPendingPayments(Array.isArray(list) ? list.length : 0);
    } catch {
      setPendingPayments(0);
    }
    markAlertLoaded("pendingPayments");
  }, [scopeCan]);

  useEffect(() => {
    void loadPendingPayments();
    // Refresh in-place when any Payment row mutates anywhere in the app
    // — approve, reject, write-off, edit, revert, mark-paid, worker
    // accept-payment, etc. all fire bumpPayments() which emits this
    // event. Without this subscription the "Payments to review" badge
    // stays stale until a hard refresh after an approval.
    const onChanged = () => void loadPendingPayments();
    window.addEventListener("seedlings:payments-changed", onChanged);
    return () => window.removeEventListener("seedlings:payments-changed", onChanged);
  }, [loadPendingPayments]);

  // ---- Pending workday approvals badge (`time.view`) ----
  // State lives near the top of the component (above the tab tree)
  // because the tab JSX reads these synchronously. The loader is
  // defined here next to its peers and registered into the ref so the
  // tab can call it without a forward-reference TDZ.
  // NEEDS_ENDING rows are intentionally excluded from this count —
  // those need a force-end action first; different bucket.
  const loadPendingWorkdays = useCallback(async () => {
    if (!scopeCan("time.view")) {
      setPendingWorkdays(0);
      setPendingWorkdaysByDate([]);
      setPendingMileage(0);
      setPendingMileageByDate([]);
      markAlertLoaded("pendingWorkdays");
      return;
    }
    // Fetch both pending-summary endpoints in parallel — the alert
    // dot on the title bar shows a combined count so the operator
    // sees "approvals to review" as a single urgency signal, while
    // the drill-in surfaces preserve the workday vs mileage split.
    try {
      const [wd, ml] = await Promise.all([
        apiGet<{
          totalPending: number;
          byDate: { workdayDate: string; count: number }[];
        }>("/api/workdays/pending-summary").catch(() => null),
        apiGet<{
          totalPending: number;
          byDate: { entryDate: string; count: number }[];
        }>("/api/mileage/pending-summary").catch(() => null),
      ]);
      setPendingWorkdays(wd?.totalPending ?? 0);
      setPendingWorkdaysByDate(Array.isArray(wd?.byDate) ? wd.byDate : []);
      setPendingMileage(ml?.totalPending ?? 0);
      setPendingMileageByDate(Array.isArray(ml?.byDate) ? ml.byDate : []);
    } catch {
      setPendingWorkdays(0);
      setPendingWorkdaysByDate([]);
      setPendingMileage(0);
      setPendingMileageByDate([]);
    }
    markAlertLoaded("pendingWorkdays");
  }, [scopeCan]);

  const loadLedgerFollowupCount = useCallback(async () => {
    if (!scopeCan("books.view")) {
      setLedgerFollowupCount(0);
      markAlertLoaded("ledgerFollowups");
      return;
    }
    try {
      const r = await apiGet<{ count: number }>("/api/ledger-followups/count");
      setLedgerFollowupCount(r?.count ?? 0);
    } catch {
      setLedgerFollowupCount(0);
    }
    markAlertLoaded("ledgerFollowups");
  }, [scopeCan]);

  const loadStreamPauseRemindersCount = useCallback(async () => {
    if (!scopeCan("schedule.view")) {
      setStreamPauseRemindersCount(0);
      markAlertLoaded("streamPauseReminders");
      return;
    }
    try {
      const r = await apiGet<{ count: number }>("/api/stream-pauses/reminders/count");
      setStreamPauseRemindersCount(r?.count ?? 0);
    } catch {
      setStreamPauseRemindersCount(0);
    }
    markAlertLoaded("streamPauseReminders");
  }, [scopeCan]);

  const loadGhostExpiryCounts = useCallback(async () => {
    if (!scopeCan("schedule.view")) {
      setGhostExpiringCount(0);
      setGhostExpiredCount(0);
      markAlertLoaded("ghostExpiry");
      return;
    }
    try {
      const r = await apiGet<{ expiringSoon: number; expired: number }>(
        "/api/occurrences/ghost-expiry-counts",
      );
      setGhostExpiringCount(r?.expiringSoon ?? 0);
      setGhostExpiredCount(r?.expired ?? 0);
    } catch {
      setGhostExpiringCount(0);
      setGhostExpiredCount(0);
    }
    markAlertLoaded("ghostExpiry");
  }, [scopeCan]);

  const loadDueToRecordCount = useCallback(async () => {
    if (!scopeCan("books.view")) {
      setDueToRecordCount(0);
      markAlertLoaded("dueToRecord");
      return;
    }
    try {
      const r = await apiGet<{ count: number }>("/api/business-expenses/due-soon/count");
      setDueToRecordCount(r?.count ?? 0);
    } catch {
      setDueToRecordCount(0);
    }
    markAlertLoaded("dueToRecord");
  }, [scopeCan]);

  const loadPolicyReviewCounts = useCallback(async () => {
    if (!scopeCan("compliance.view")) {
      setPolicyPendingUploadsCount(0);
      setPolicyPendingApprovalsCount(0);
      markAlertLoaded("policyReview");
      return;
    }
    try {
      const r = await apiGet<{ pendingUploadReviews: number; pendingApprovals: number }>(
        "/api/policies/counts",
      );
      setPolicyPendingUploadsCount(r?.pendingUploadReviews ?? 0);
      setPolicyPendingApprovalsCount(r?.pendingApprovals ?? 0);
    } catch {
      setPolicyPendingUploadsCount(0);
      setPolicyPendingApprovalsCount(0);
    }
    markAlertLoaded("policyReview");
  }, [scopeCan]);

  const loadPolicyWorkerCount = useCallback(async () => {
    // Anyone on staff with a workerType sees this — it is their own
    // compliance queue, so it is an OWNERSHIP route and asks for no
    // entitlement. Somebody with workerType=null gets 0 back from the
    // server and the alert simply does not render. Skipped entirely for
    // client accounts: the endpoint is staff-only and 403s.
    if (!isSignedIn || !hasAnyRole) {
      setPolicyWorkerPendingCount(0);
      markAlertLoaded("policyWorker");
      return;
    }
    try {
      const r = await apiGet<{ pendingCount: number }>("/api/me/policies/count");
      setPolicyWorkerPendingCount(r?.pendingCount ?? 0);
    } catch {
      setPolicyWorkerPendingCount(0);
    }
    markAlertLoaded("policyWorker");
  }, [isSignedIn, hasAnyRole]);

  // Keep the ref in sync so the tab's onApprovalsChanged callback,
  // which was bound up at the top of the component body, can call
  // through to the latest version.
  useEffect(() => {
    loadPendingWorkdaysRef.current = loadPendingWorkdays;
  }, [loadPendingWorkdays]);

  useEffect(() => {
    void loadPendingWorkdays();
  }, [loadPendingWorkdays]);

  // Initial fetch of the ledger-followup count + listener for the
  // cross-tab bus event so the alerts dot stays in sync when someone with `settings.manage`
  // flags/resolves a row from the Ledger tab.
  useEffect(() => {
    void loadLedgerFollowupCount();
    const onChanged = () => void loadLedgerFollowupCount();
    window.addEventListener("seedlings:ledger-followups-changed", onChanged);
    return () => window.removeEventListener("seedlings:ledger-followups-changed", onChanged);
  }, [loadLedgerFollowupCount]);

  // Same pattern for the Due-to-Record alert — fires when a caller with `settings.manage`
  // skips / records / marks-already-recorded a row on the Ledger panel.
  useEffect(() => {
    void loadDueToRecordCount();
    const onChanged = () => void loadDueToRecordCount();
    window.addEventListener("seedlings:due-to-record-changed", onChanged);
    return () => window.removeEventListener("seedlings:due-to-record-changed", onChanged);
  }, [loadDueToRecordCount]);

  // Stream-pause reminders — fires when someone with `schedule.manage` pauses/updates/resumes
  // a stream in ServicesTab. Keeps the alert badge in lockstep.
  useEffect(() => {
    void loadStreamPauseRemindersCount();
    const onChanged = () => void loadStreamPauseRemindersCount();
    window.addEventListener("seedlings:stream-pauses-changed", onChanged);
    return () => window.removeEventListener("seedlings:stream-pauses-changed", onChanged);
  }, [loadStreamPauseRemindersCount]);

  // Next-visit ghost counts. A ghost appears or clears whenever the visit
  // blocking it moves — most often a payment landing — so this rides the
  // same jobs-changed signal the feed does.
  useEffect(() => {
    void loadGhostExpiryCounts();
    const onChanged = () => void loadGhostExpiryCounts();
    window.addEventListener("seedlings3:jobs-changed", onChanged);
    return () => window.removeEventListener("seedlings3:jobs-changed", onChanged);
  }, [loadGhostExpiryCounts]);

  // Compliance-policy alert refresh. Reloads on any policy signature or
  // version state change so a caller with `schedule.manage`-side "pending uploads" badge stays
  // fresh, and the worker-side "documents to sign" badge clears the moment
  // the interceptor fires policies:signed after a successful wizard flow.
  useEffect(() => {
    void loadPolicyReviewCounts();
    void loadPolicyWorkerCount();
    const onSigned = () => {
      void loadPolicyReviewCounts();
      void loadPolicyWorkerCount();
    };
    window.addEventListener("policies:signed", onSigned);
    window.addEventListener("policies:changed", onSigned);
    return () => {
      window.removeEventListener("policies:signed", onSigned);
      window.removeEventListener("policies:changed", onSigned);
    };
  }, [loadPolicyReviewCounts, loadPolicyWorkerCount]);

  // ---- Awaiting-client-payment badge (`money.view`) ----
  // Counts every outstanding payment request — sent to a client, not paid
  // back yet. The worklist on the Money → Payments tab still flags the
  // stale ones (past PAYMENT_REQUEST_STALE_DAYS) visually; the alert
  // surfaces the full set so a fresh request doesn't sit unseen either.
  const [awaitingClientPaymentCount, setAwaitingClientPaymentCount] = useState<number>(0);
  const [staleRequestCount, setStaleRequestCount] = useState<number>(0);

  const loadAwaitingClientPayment = useCallback(async () => {
    if (!scopeCan("money.view")) {
      setAwaitingClientPaymentCount(0);
      setStaleRequestCount(0);
      markAlertLoaded("awaitingClientPayment");
      return;
    }
    try {
      const list = await apiGet<{ stale: boolean }[]>("/api/payment-requests/outstanding");
      const arr = Array.isArray(list) ? list : [];
      setAwaitingClientPaymentCount(arr.length);
      setStaleRequestCount(arr.filter((r) => r.stale).length);
    } catch {
      setAwaitingClientPaymentCount(0);
      setStaleRequestCount(0);
    }
    markAlertLoaded("awaitingClientPayment");
  }, [scopeCan]);

  useEffect(() => {
    void loadAwaitingClientPayment();
    // Same event the pending-approvals counter subscribes to — when a
    // payment lands (approve, mark-paid, etc.), the matching
    // outstanding request disappears from this list, so the badge has
    // to recount too. Kept on the same bus so any payment mutation
    // refreshes both halves of "Payments to review" together.
    const onChanged = () => void loadAwaitingClientPayment();
    window.addEventListener("seedlings:payments-changed", onChanged);
    return () => window.removeEventListener("seedlings:payments-changed", onChanged);
  }, [loadAwaitingClientPayment]);

  // Overdue count for admin header badge — matches Admin Jobs tab
  // overdue logic. Predicate lives in lib/overdueRule so all three
  // overdue sites (this badge, ServicesTab chip, JobsTab chip) stay in
  // sync. PENDING_PAYMENT rows only count once the invoice pay link has
  // expired (per PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS setting) — matches
  // "we can't do anything until the link times out" mental model.
  const [overdueCount, setOverdueCount] = useState(0);
  /** TASK / REMINDER / FOLLOWUP / EVENT past their date. Same fetch and the
   *  same rule as Job Overdue — they differ only by workflow, so counting
   *  them in one pass keeps the two numbers from ever drifting apart. */
  const [activitiesOverdueCount, setActivitiesOverdueCount] = useState(0);
  const loadOverdue = useCallback(async () => {
    if (!scopeCan("schedule.view")) { setOverdueCount(0); markAlertLoaded("overdue"); return; }
    try {
      const today = bizToday();
      const toStr = bizYesterday();
      const fromStr = bizAddDays(today, -60);
      const [list, expiryHours] = await Promise.all([
        apiGet<any[]>(`/api/occurrences?from=${fromStr}&to=${toStr}`),
        loadPaymentRequestExpiryHours(),
      ]);
      const nowMs = Date.now();
      let jobs = 0;
      let activities = 0;
      for (const o of Array.isArray(list) ? list : []) {
        // Extra 60-day lower bound preserves the badge's existing
        // scope (don't scan ancient history for the alert count).
        if (!o.startAt || bizDateKey(o.startAt) < fromStr) continue;
        const kind = overdueKind(o, { todayKey: today, expiryHours, nowMs });
        if (kind === "job") jobs++;
        else if (kind === "activity") activities++;
      }
      setOverdueCount(jobs);
      setActivitiesOverdueCount(activities);
    } catch {
      setOverdueCount(0);
      setActivitiesOverdueCount(0);
    }
    markAlertLoaded("overdue");
  }, [scopeCan]);

  useEffect(() => {
    void loadOverdue();
    // Also refresh when jobs change (e.g., status update, payment accepted)
    const onRefresh = () => void loadOverdue();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadOverdue]);

  // Client change-request count for admin header badge.
  // Counts PENDING reschedule + skip requests submitted by clients via
  // ClientMyJobsTab. Refreshed when jobs change (any admin acting on a
  // request fires the same `jobs-changed` event we already listen to).
  const [changeRequestCount, setChangeRequestCount] = useState(0);
  const loadChangeRequestCount = useCallback(async () => {
    if (!scopeCan("schedule.view")) { setChangeRequestCount(0); markAlertLoaded("changeRequests"); return; }
    try {
      const result = await apiGet<{ count: number }>("/api/change-requests/pending-count");
      setChangeRequestCount(result?.count ?? 0);
    } catch {
      setChangeRequestCount(0);
    }
    markAlertLoaded("changeRequests");
  }, [scopeCan]);
  useEffect(() => {
    void loadChangeRequestCount();
    const onRefresh = () => void loadChangeRequestCount();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadChangeRequestCount]);

  // Estimate follow-up count for the header badge. Estimates whose
  // proposal was sent to the client but no ACCEPTED/REJECTED came back
  // within 1–4 weeks of the visit. Acts as a soft nudge while the window
  // is open, then lets the alert fall off after 4 weeks.
  const [estimateFollowupCount, setEstimateFollowupCount] = useState(0);
  const loadEstimateFollowupCount = useCallback(async () => {
    // Always mark loaded on early-exit. For somebody without the
    // entitlement the answer never changes, so the dep never triggers a
    // re-fire and gating on `if (me)` here would leave the badge stuck
    // pulsating.
    if (!scopeCan("estimates.create")) {
      setEstimateFollowupCount(0);
      markAlertLoaded("estimateFollowups");
      return;
    }
    try {
      const result = await apiGet<{ count: number }>("/api/estimates/stale-followup-count");
      setEstimateFollowupCount(result?.count ?? 0);
    } catch {
      setEstimateFollowupCount(0);
    }
    markAlertLoaded("estimateFollowups");
  }, [scopeCan]);
  useEffect(() => {
    void loadEstimateFollowupCount();
    const onRefresh = () => void loadEstimateFollowupCount();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadEstimateFollowupCount]);

  // Unapproved-hours count for the header badge. Completed STANDARD/ONE_OFF
  // occurrences whose hours haven't been admin-approved — excluded from the
  // Gusto W-2 export until reviewed. Sticky across job statuses (a CLOSED
  // job can still have unapproved hours).
  const [unapprovedHoursCount, setUnapprovedHoursCount] = useState(0);
  const loadUnapprovedHoursCount = useCallback(async () => {
    if (!scopeCan("time.approve")) {
      setUnapprovedHoursCount(0);
      markAlertLoaded("unapprovedHours");
      return;
    }
    try {
      const result = await apiGet<{ count: number }>("/api/occurrences/unapproved-hours-count");
      setUnapprovedHoursCount(result?.count ?? 0);
    } catch {
      setUnapprovedHoursCount(0);
    }
    markAlertLoaded("unapprovedHours");
  }, [scopeCan]);
  useEffect(() => {
    void loadUnapprovedHoursCount();
    const onRefresh = () => void loadUnapprovedHoursCount();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadUnapprovedHoursCount]);

  // Education guides awaiting approval. `content.approve` — the guard on
  // /guides/pending-approvals/count, and on approving itself. Approving is
  // the only way material becomes readable, so a pending guide is work
  // blocked on whoever holds that entitlement and nobody else.
  const [guideApprovalCount, setGuideApprovalCount] = useState(0);
  const loadGuideApprovalCount = useCallback(async () => {
    if (!scopeCan("content.approve")) {
      setGuideApprovalCount(0);
      markAlertLoaded("guideApprovals");
      return;
    }
    try {
      const r = await fetchGuidePendingCount();
      setGuideApprovalCount(r?.count ?? 0);
    } catch {
      setGuideApprovalCount(0);
    }
    markAlertLoaded("guideApprovals");
  }, [scopeCan]);
  useEffect(() => {
    void loadGuideApprovalCount();
    const onRefresh = () => void loadGuideApprovalCount();
    window.addEventListener("seedlings:guides-changed", onRefresh);
    return () => window.removeEventListener("seedlings:guides-changed", onRefresh);
  }, [loadGuideApprovalCount]);

  // Records → Guides, where the review queue lives.
  const goToGuideApprovals = useCallback(() => {
    setTopTab("staff");
    setStaffCategory("Records");
    setStaffInnerTab("guides");
  }, []);

  // Unlinked client accounts. This was a Tasks section with NO dropdown
  // alert — the only such gap — so an operator who never opened Tasks had
  // no signal at all. Added 2026-08-26 when the two surfaces were
  // reconciled; see the alert-ordering build gate.
  const [unlinkedAccountsCount, setUnlinkedAccountsCount] = useState(0);
  const loadUnlinkedAccountsCount = useCallback(async () => {
    if (!scopeCan("clients.view")) {
      setUnlinkedAccountsCount(0);
      markAlertLoaded("unlinkedAccounts");
      return;
    }
    try {
      const list = await apiGet<unknown[]>("/api/clients/unlinked-accounts");
      setUnlinkedAccountsCount(Array.isArray(list) ? list.length : 0);
    } catch {
      setUnlinkedAccountsCount(0);
    }
    markAlertLoaded("unlinkedAccounts");
  }, [scopeCan]);
  useEffect(() => {
    void loadUnlinkedAccountsCount();
    const onRefresh = () => void loadUnlinkedAccountsCount();
    window.addEventListener("seedlings:client-accounts-changed", onRefresh);
    return () => window.removeEventListener("seedlings:client-accounts-changed", onRefresh);
  }, [loadUnlinkedAccountsCount]);

  // Payroll names awaiting identity matching. `payroll.manage` — the guard
  // on /payroll/identities/unmatched. Matching a name to a User is the one
  // payroll action that changes who can see whose pay, so it sits behind
  // the same entitlement as the import itself.
  //
  // This count is not cosmetic. Until a name is matched, THAT WORKER CANNOT
  // SEE THEIR OWN PAY — and the worker's only signal is a passive "ask your
  // admin" line, because they are deliberately never told whose row it is.
  // Before this existed the queue was visible only inside the Payroll tab,
  // so the one person who could fix it had to happen to go looking, while
  // the person affected was told to go ask them.
  const [payrollUnmatchedCount, setPayrollUnmatchedCount] = useState(0);
  const loadPayrollUnmatchedCount = useCallback(async () => {
    if (!scopeCan("payroll.manage")) {
      setPayrollUnmatchedCount(0);
      markAlertLoaded("payrollUnmatched");
      return;
    }
    try {
      const rows = await fetchUnmatchedPayrollNames();
      setPayrollUnmatchedCount(Array.isArray(rows) ? rows.length : 0);
    } catch {
      setPayrollUnmatchedCount(0);
    }
    markAlertLoaded("payrollUnmatched");
  }, [scopeCan]);
  useEffect(() => {
    void loadPayrollUnmatchedCount();
    // An import adds names to the queue; a match removes one. Both fire
    // this, so the badge settles without a manual refresh.
    const onRefresh = () => void loadPayrollUnmatchedCount();
    window.addEventListener("seedlings:payroll-changed", onRefresh);
    return () => window.removeEventListener("seedlings:payroll-changed", onRefresh);
  }, [loadPayrollUnmatchedCount]);

  // Money → Payroll, where the review queue lives.
  const goToPayrollIdentities = useCallback(() => {
    setTopTab("staff");
    setStaffCategory("Money");
    setStaffInnerTab("payroll");
  }, []);

  // Navigate to admin Jobs tab filtered to unapproved-hours occurrences.
  // Same handoff pattern as overdue / estimate-followups: localStorage flag
  // for mount-time pickup + dispatched event for already-mounted case.
  /**
   * Navigate to a surface that exists for BOTH Admin and Super, without
   * changing the role the operator is acting as.
   *
   * Alert handlers used to hardcode `setTopTab("staff")`, so someone with `settings.manage` who
   * clicked "Overdue" or "Unclaimed" was silently demoted to a caller with `schedule.manage`
   * tab — different sections, different affordances, and no way to tell
   * why (reported 2026-08-27).
   *
   * One destination, because there is one staff tab list. This used to
   * branch on the current shell and take two possible tabs, falling through
   * when a surface had no equivalent on the higher one.
   */
  const gotoOperatorSurface = useCallback(
    (opts: {
      tab: string;
      category?: string;
    }) => {
      setTopTab("staff");
      if (opts.category) setStaffCategory(opts.category);
      setStaffInnerTab(opts.tab as StaffTabs);
    },
    [topTab],
  );

  const goToUnapprovedHours = useCallback(() => {
    try {
      localStorage.setItem("seedlings_jobs_showUnapprovedHours", "1");
      localStorage.setItem("seedlings_jobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("staffJobs:showUnapprovedHours"));
    }, 100);
  }, [gotoOperatorSurface]);

  // Navigate to admin Jobs tab with the estimate-followup filter applied.
  // Mirrors goToOverdue / goToUnclaimed: writes a flag to localStorage so
  // the tab picks it up on mount, then fires an event in case it's already
  // mounted.
  const goToEstimateFollowups = useCallback(() => {
    try {
      localStorage.setItem("seedlings_jobs_showEstimateFollowups", "1");
      localStorage.setItem("seedlings_jobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("staffJobs:showEstimateFollowups"));
    }, 100);
  }, [gotoOperatorSurface]);

  // Unclaimed count for admin header badge
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const loadUnclaimed = useCallback(async () => {
    // `/api/operations` needs `reports.view`. It was gated on the
    // schedule-manage flag instead — which is
    // `schedule.manage` — this badge 403'd on EVERY page load for anyone
    // who runs the schedule without reading the business rollup. A
    // coordinator is exactly that person.
    if (!scopeCan("reports.view")) { setUnclaimedCount(0); markAlertLoaded("unclaimed"); return; }
    try {
      const d = computeDatesFromPreset("overdueAndNext3");
      const qs = new URLSearchParams();
      if (d.from) qs.set("from", d.from);
      if (d.to) qs.set("to", d.to);
      const result = await apiGet<{ jobs: { unclaimed: number } }>(`/api/operations?${qs}`);
      setUnclaimedCount(result?.jobs?.unclaimed ?? 0);
    } catch {
      setUnclaimedCount(0);
    }
    markAlertLoaded("unclaimed");
  }, [scopeCan]);

  useEffect(() => {
    void loadUnclaimed();
    const onRefresh = () => void loadUnclaimed();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadUnclaimed]);

  // Announcement count badge (Now — today + next 2 days, visible to all)
  const [announcementCount, setAnnouncementCount] = useState(0);
  const [alertDropdownOpen, setAlertDropdownOpen] = useState(false);
  useEffect(() => {
    if (!alertDropdownOpen) return;
    const close = (e: MouseEvent) => {
      // Don't close if clicking inside the dropdown
      const dropdown = document.querySelector("[data-alert-dropdown]");
      if (dropdown && dropdown.contains(e.target as Node)) return;
      setAlertDropdownOpen(false);
    };
    const timer = setTimeout(() => document.addEventListener("click", close), 100);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [alertDropdownOpen]);
  const [alertsLoaded, setAlertsLoaded] = useState<Record<string, boolean>>({});
  const alertsReady = !!(alertsLoaded.pending && alertsLoaded.overdue && alertsLoaded.unclaimed && alertsLoaded.announcements && alertsLoaded.pendingPayments && alertsLoaded.awaitingClientPayment && alertsLoaded.changeRequests && alertsLoaded.estimateFollowups && alertsLoaded.unapprovedHours && alertsLoaded.pendingWorkdays && alertsLoaded.ledgerFollowups && alertsLoaded.dueToRecord && alertsLoaded.streamPauseReminders && alertsLoaded.ghostExpiry && alertsLoaded.policyReview && alertsLoaded.policyWorker && alertsLoaded.timeline && alertsLoaded.payrollUnmatched && alertsLoaded.unlinkedAccounts && alertsLoaded.guideApprovals);
  const markAlertLoaded = useCallback((key: string) => setAlertsLoaded((prev) => prev[key] ? prev : { ...prev, [key]: true }), []);
  const loadAnnouncementCount = useCallback(async () => {
    // ASK FOR THE CAPABILITY THE ROUTE ASKS FOR. This used to say
    // "staff-only" and test `hasAnyRole`, i.e. holds ANYTHING — which a
    // bookkeeper does, while holding no `schedule.view`. The result was two
    // 403s on every page load for anyone whose role is not field-shaped.
    if (!me?.isApproved || !scopeCan("schedule.view")) {
      setAnnouncementCount(0);
      if (me) markAlertLoaded("announcements");
      return;
    }
    // Check if user already dismissed announcements today
    try {
      const dismissedDate = localStorage.getItem("seedlings_announcements_dismissed");
      if (dismissedDate === bizDateKey(new Date())) { setAnnouncementCount(0); markAlertLoaded("announcements"); return; }
    } catch {}
    try {
      const todayStr = bizDateKey(new Date());
      const list = await apiGet<any[]>(`/api/occurrences?from=${todayStr}&to=${todayStr}`);
      const count = (Array.isArray(list) ? list : []).filter(
        (o) => o.workflow === "ANNOUNCEMENT" && o.status === "SCHEDULED"
      ).length;
      setAnnouncementCount(count);
    } catch {
      setAnnouncementCount(0);
    }
    markAlertLoaded("announcements");
  }, [me?.isApproved, hasAnyRole]);

  useEffect(() => {
    void loadAnnouncementCount();
    const onRefresh = () => void loadAnnouncementCount();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadAnnouncementCount]);

  const goToAnnouncements = useCallback(() => {
    // Mark announcements as seen for today
    try { localStorage.setItem("seedlings_announcements_dismissed", bizDateKey(new Date())); } catch {}
    setAnnouncementCount(0);
    setTopTab("staff");
    setStaffInnerTab("jobs" as any);
    try { localStorage.setItem("seedlings_jobs_showAnnouncements", "1"); } catch {}
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("staffJobs:showAnnouncements"));
    }, 150);
  }, []);

  const goToUnclaimed = useCallback(() => {
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    // Signal the Jobs tab to apply unclaimed filter
    try { localStorage.setItem("seedlings_jobs_showUnclaimed", "1"); } catch {}
    // Also dispatch event in case the tab is already mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("staffJobs:showUnclaimed"));
    }, 50);
  }, [gotoOperatorSurface]);

  const goToActivitiesOverdue = useCallback(() => {
    try {
      localStorage.setItem("seedlings_jobs_showActivitiesOverdue", "1");
      // Same "View as" clear as goToOverdue — the count is company-wide, so
      // landing on a list scoped to one worker would show fewer rows than
      // the badge promised.
      localStorage.setItem("seedlings_jobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("staffJobs:showActivitiesOverdue"));
    }, 50);
  }, [gotoOperatorSurface]);

  const goToOverdue = useCallback(() => {
    try {
      localStorage.setItem("seedlings_jobs_showOverdue", "1");
      // Clear the "View as" user filter so all overdue jobs are shown
      localStorage.setItem("seedlings_jobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    // Also dispatch event for when component is already mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("staffJobs:showOverdue"));
    }, 100);
  }, [gotoOperatorSurface]);

  // Next-visit ghost alerts → Jobs, narrowed to the matching placeholder
  // bucket. Same localStorage-flag-plus-event shape as goToOverdue: the flag
  // covers a cold mount, the event covers an already-mounted tab.
  const goToGhostBucket = useCallback((bucket: "expiring" | "expired") => {
    const key = bucket === "expired"
      ? "seedlings_jobs_showExpiredGhosts"
      : "seedlings_jobs_showExpiringGhosts";
    try {
      localStorage.setItem(key, "1");
      // Clear "View as" so every matching ghost shows, not just one
      // worker's — mirrors goToOverdue.
      localStorage.setItem("seedlings_jobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(
        bucket === "expired" ? "staffJobs:showExpiredGhosts" : "staffJobs:showExpiringGhosts",
      ));
    }, 100);
  }, [gotoOperatorSurface]);
  const goToExpiringGhosts = useCallback(() => goToGhostBucket("expiring"), [goToGhostBucket]);
  const goToExpiredGhosts = useCallback(() => goToGhostBucket("expired"), [goToGhostBucket]);

  // Jump to the Jobs tab and scroll to the Client Requests section.
  // The section is mounted at the top of the Jobs view for holders of `schedule.manage`, so we
  // navigate there and then scroll-into-view its anchor.
  const goToClientRequests = useCallback(() => {
    gotoOperatorSurface({ tab: "jobs", category: "Work" });
    setTimeout(() => {
      const el = document.getElementById("client-requests-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }, [gotoOperatorSurface]);

  // Lands on Directory → Clients where the
  // UnlinkedClientAccountsSection is hosted. Used by Tasks page's
  // collapsible card's "Goto Task" icon button so the operator can
  // jump to the section's home tab if they prefer working there.
  const goToUnlinkedAccounts = useCallback(() => {
    gotoOperatorSurface({ tab: "clients", category: "Directory" });
  }, [gotoOperatorSurface]);

  // Timeline alert — merged count of urgent timeline events + expiring
  // documents (urgent = past or ≤7 days). Hidden events are filtered out
  // server-side unless the caller holds `timeline.manage`.
  const [timelineUrgentCount, setTimelineUrgentCount] = useState(0);
  const loadTimelineCount = useCallback(async () => {
    // Same shape as the unclaimed badge above: this reads the timeline, so
    // it asks for `timeline.view` rather than for a role flag. A coordinator
    // runs the schedule and does not read the company timeline.
    if (!scopeCan("timeline.view")) { setTimelineUrgentCount(0); if (me) markAlertLoaded("timeline"); return; }
    try {
      // ONE endpoint, which decides how much to return from the caller's
      // capability rather than from which URL was asked for.
      const r = await apiGet<{ urgent: number; soon: number }>("/api/timeline/upcoming-counts");
      setTimelineUrgentCount(r?.urgent ?? 0);
    } catch {
      setTimelineUrgentCount(0);
    }
    markAlertLoaded("timeline");
  }, [scopeCan, me]);

  useEffect(() => {
    void loadTimelineCount();
    const onRefresh = () => void loadTimelineCount();
    window.addEventListener("seedlings3:documents-changed", onRefresh);
    window.addEventListener("seedlings3:timeline-changed", onRefresh);
    return () => {
      window.removeEventListener("seedlings3:documents-changed", onRefresh);
      window.removeEventListener("seedlings3:timeline-changed", onRefresh);
    };
  }, [loadTimelineCount]);

  // Manual refresh of every alert-bar count. Surfaces as a small Refresh
  // button at the top of the alert dropdown so the operator can force a
  // recount after an action that may not have propagated through the
  // existing event-based refresh paths.
  const [alertsRefreshing, setAlertsRefreshing] = useState(false);
  const refreshAllAlerts = useCallback(async () => {
    setAlertsRefreshing(true);
    try {
      await Promise.all([
        loadPending(),
        loadPendingPayments(),
        loadPendingWorkdays(),
        loadAwaitingClientPayment(),
        loadOverdue(),
        loadChangeRequestCount(),
        loadEstimateFollowupCount(),
        loadUnapprovedHoursCount(),
        loadUnclaimed(),
        loadAnnouncementCount(),
        loadTimelineCount(),
        loadLedgerFollowupCount(),
        loadDueToRecordCount(),
        loadStreamPauseRemindersCount(),
        loadGhostExpiryCounts(),
        // Policy counts — omitted from this list originally, which meant
        // clicking the dropdown refresh button never updated "Documents
        // to sign" or a caller with `schedule.manage`-side compliance queues. The worker who
        // signed a policy on another device would see the stale count
        // until they closed the browser tab. Reported on 2026-07-13.
        loadPolicyWorkerCount(),
        loadPolicyReviewCounts(),
        loadPayrollUnmatchedCount(),
        loadUnlinkedAccountsCount(),
        loadGuideApprovalCount(),
      ]);
    } finally {
      setAlertsRefreshing(false);
    }
  }, [
    loadPending, loadPendingPayments, loadPendingWorkdays, loadAwaitingClientPayment,
    loadOverdue, loadChangeRequestCount, loadEstimateFollowupCount,
    loadUnapprovedHoursCount, loadUnclaimed, loadAnnouncementCount,
    loadTimelineCount, loadLedgerFollowupCount,
    loadDueToRecordCount, loadStreamPauseRemindersCount,
    loadPolicyWorkerCount, loadPolicyReviewCounts,
  ]);

  // Opening the Tasks page fires the same full refresh as tapping
  // the refresh button on the alerts dropdown. Keeps counts + inline
  // section contents from going stale between the moment the user
  // last saw the dropdown and when they land on the page. Also
  // keeps the two surfaces in lockstep: any action taken on Tasks
  // will re-fetch on close via the existing event-bus paths, and
  // the same recount happens on the next open.
  useEffect(() => {
    if (tasksOpen) void refreshAllAlerts();
  }, [tasksOpen, refreshAllAlerts]);

  const goToTimeline = useCallback(() => {
    try { sessionStorage.setItem("pendingTimelineUrgencyFilter", "urgent"); } catch {}
    gotoOperatorSurface({ tab: "timeline", category: "Records" });
  }, [gotoOperatorSurface]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onOpenUsers = (e: Event) => {
      const { status } =
        (e as CustomEvent<{ status?: "pending" | "approved" | "all" }>)
          .detail || {};
      // optional: validate
      const ok =
        status === "pending" || status === "approved" || status === "all";
      if (!ok) return;

      // There is one Users tab, so this routes to it unconditionally and
      // UsersTab decides what to show from `people.view` / `people.manage`
      // / `people.approve`. Both dispatchers of this event already route
      // here; this listener was the stale one, and because it fires on a
      // 100ms timeout it ran AFTER the handler's own navigation and quietly
      // overrode it. That is why the "Pending Users" alert used to land on
      // a Users tab with no pending section (reported 2026-08-27).
      setTopTab("staff");
      setStaffCategory("Directory");
      setStaffInnerTab("users");

      window.sessionStorage.setItem(
        "users:openOnce",
        JSON.stringify({ status })
      );
    };

    window.addEventListener("users:open", onOpenUsers as EventListener);
    return () =>
      window.removeEventListener(
        "users:open",
        onOpenUsers as EventListener
      );
  }, []);

  useEffect(() => {
    const onUsersChanged = () => { void loadPending(); void refreshMe(); };
    window.addEventListener("seedlings3:users-changed", onUsersChanged);
    return () =>
      window.removeEventListener("seedlings3:users-changed", onUsersChanged);
  }, [loadPending]);

  // Listen for profile navigation
  useEffect(() => {
    const onProfile = (e: Event) => {
      const { userId, otherUser } = (e as CustomEvent).detail || {};
      // Push the current tab onto the nav history stack BEFORE switching
      // so the back button (in-app or browser/OS gesture) can return the
      // user to where they were. Every other programmatic tab switch
      // that participates in back-navigation uses pushNavHistory; this
      // handler was previously missing it, so "View profile" jumps into
      // Profile but the back button has no state to restore.
      pushNavHistory(getCurrentNavState());
      if (otherUser && scopeCan("people.view")) {
        setTopTab("staff");
        setStaffInnerTab("profile");
        // Set the selected user in profile via localStorage (ProfileTab reads it)
        try { localStorage.setItem("seedlings_profile_userId", JSON.stringify(userId === me?.id ? "" : userId)); } catch {}
        window.dispatchEvent(new CustomEvent("profile:selectUser", { detail: { userId } }));
      } else {
        setTopTab("staff");
        setStaffInnerTab("profile");
      }
    };
    window.addEventListener("navigate:profile", onProfile as EventListener);
    return () => window.removeEventListener("navigate:profile", onProfile as EventListener);
  }, [scopeCan, me?.id]);

  // THE staff-tab navigation handler. One listener for `navigate:staffTab`.
  //
  // There were THREE, one per old shell (worker, admin, super). Collapsing
  // the shells merged the EVENT but left all three subscribed, so a single
  // jump ran every one of them: `pushNavHistory` up to three times for one
  // navigation — which is why Back sometimes needed several presses — three
  // `setStaffInnerTab` calls, and three different answers for the category,
  // last writer winning.
  //
  // Their category maps also disagreed. the copy was missing ten tabs
  // (Ledger, Promotions, Forecast, Reconcile, Workdays, Compliance, Audit,
  // Tools, Vanity, Displays), so a jump to any of those resolved nothing and
  // left the strip on the old category with the wrong inner tabs showing.
  // `TAB_CATEGORY` at the top of this file is now the single map.
  const programmaticNavRef = useRef(false);
  useEffect(() => {
    const onNav = (e: Event) => {
      const { tab, category, autoAnalyze, filter, remount } = (e as CustomEvent).detail || {};
      if (!tab) return;
      const current = getCurrentNavState();
      // Compared against "worker" / "admin" / "super" in the three originals
      // — shell names that no longer exist, so this was always true and every
      // jump pushed history even when it went nowhere.
      const wouldChange =
        current.outer !== "staff" ||
        current.inner !== tab ||
        (category && current.category !== category);
      if (wouldChange) pushNavHistory(current);
      programmaticNavRef.current = true;
      setTopTab("staff");
      setStaffInnerTab(tab as any);
      // An explicit category wins; otherwise the destination's own.
      const destCategory = category ?? TAB_CATEGORY[tab];
      if (destCategory) setStaffCategory(destCategory);
      // Remount the destination so its `usePersistedState` hooks re-read the
      // localStorage the caller just pre-wrote (no flicker).
      if (remount) {
        if (tab === "jobs") setJobsRemountKey((k) => k + 1);
        else if (tab === "equipment") setEquipmentRemountKey((k) => k + 1);
        else if (tab === "payments") setPaymentsRemountKey((k) => k + 1);
      }
      if (autoAnalyze && tab === "routes") {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("routes:autoAnalyze"));
        }, 300);
      }
      // Legacy: event-driven filter for flows not yet on the remount pattern.
      if (filter && tab === "jobs") {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("jobs:applyFilter", { detail: filter }));
        }, 300);
      }
      if (filter && tab === "equipment") {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("equipment:applyFilter", { detail: filter }));
        }, 300);
      }
      if (filter && tab === "payments") {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("payments:applyFilter", { detail: filter }));
        }, 300);
      }
      setTimeout(() => { programmaticNavRef.current = false; }, 50);
    };
    window.addEventListener("navigate:staffTab", onNav as EventListener);
    return () => window.removeEventListener("navigate:staffTab", onNav as EventListener);
  }, []);



  // Listen for "launch New Job Setup with estimate defaults" from JobsTab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setWorkflowEstimateDefaults(detail ?? null);
      setTopTab("staff");
      launchWorkflow("new-job-setup");
    };
    window.addEventListener("trigger:newJobSetupFromEstimate", handler);
    return () => window.removeEventListener("trigger:newJobSetupFromEstimate", handler);
  }, []);

  // Listen for workflow triggers (e.g., returning from Routes to Plan Workday)
  useEffect(() => {
    const onTrigger = (e: Event) => {
      const { id } = (e as CustomEvent).detail || {};
      if (id) setActiveWorkflow(id);
    };
    window.addEventListener("trigger:workflow", onTrigger as EventListener);
    return () => window.removeEventListener("trigger:workflow", onTrigger as EventListener);
  }, []);

  // Auto-launch workflow from URL parameter (e.g., ?workflow=plan-workday from notification link)
  useEffect(() => {
    if (meLoading) return; // Wait for user data to load
    const wf = router.query.workflow as string | undefined;
    if (wf && me?.isApproved) {
      setTopTab("staff");
      setStaffInnerTab("tasks");
      setActiveWorkflow(wf);
      // Clean the URL without reloading
      router.replace("/", undefined, { shallow: true });
    }
  }, [router.query.workflow, me?.isApproved, meLoading]);

  // Deep-link to a specific tab via `?tab=<outer>-<category>-<inner>` (e.g.
  // `worker-work-planning`). Client tabs (no categories) use 2 segments instead:
  // `client-community`. Slugs derive from the inner tab's label (lowercased,
  // hyphenated) — the inner tab's `value` field is also accepted as a fallback so
  // existing internal IDs work too. Auth gating is delegated to each outer tab's
  // `visible` predicate; if the user can't access the outer tab the param is just
  // stripped. Like `?occ=`, the param is left intact while signed out so it
  // survives Clerk's auth redirect.
  useEffect(() => {
    if (meLoading) return;
    const tabSlug = router.query.tab as string | undefined;
    if (!tabSlug) return;

    const slugify = (s: string): string =>
      (s || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    const parts = tabSlug.split("-");
    if (parts.length < 2) {
      router.replace("/", undefined, { shallow: true });
      return;
    }

    const outerValue = parts[0];
    const outer = navTabs.find((t) => t.value === outerValue);
    if (!outer) {
      router.replace("/", undefined, { shallow: true });
      return;
    }
    // Auth gate using the outer tab's visible predicate.
    //
    // SIGNED-OUT VISITORS RESOLVE TOO, and this used to return before
    // reaching here — "wait for auth; the URL survives the redirect", which
    // assumed every deep link pointed at something behind a login. Three of
    // the client tabs are public (Community, Services, Promotions), so for
    // the one audience that matters most to a printed QR code — someone who
    // is not a customer yet — the link silently did nothing and dropped them
    // on the default tab.
    //
    // The `visible` predicate is the authorization, not the signed-in check,
    // so a public tab passes it while signed out and a private one does not.
    const outerVisible = typeof outer.visible === "function" ? outer.visible() : outer.visible;
    if (!outerVisible) {
      // Not visible AND signed out: this is probably a private tab the
      // visitor has yet to authenticate for. Leave the param intact so it
      // still survives Clerk's redirect and resolves on the way back —
      // that is the behaviour the old early-return existed to protect.
      if (!isSignedIn) return;
      router.replace("/", undefined, { shallow: true });
      return;
    }

    // Try 3-part format (<outer>-<category>-<inner>) first, then 2-part fallback.
    // The 3-part match enforces exact category alignment so deep links that
    // baked in the original category continue to resolve there. Falling back
    // by inner slug alone makes legacy URLs survive category renames
    // (e.g. old `worker-info-clients` after Info → Directory) and is safe
    // because inner tab slugs are unique within a given outer tab.
    let matched: { value: string; category?: string } | null = null;
    if (parts.length >= 3) {
      const categorySlug = parts[1];
      const innerSlug = parts.slice(2).join("-");
      for (const t of outer.innerTabs) {
        if (slugify(t.category ?? "") !== categorySlug) continue;
        if (slugify(t.label) === innerSlug || t.value === innerSlug) {
          matched = { value: t.value, category: t.category };
          break;
        }
      }
      // 3-part fallback: tolerate a stale/renamed category slug as long as
      // the inner slug still names a real tab. The tab's *current* category
      // is used (the matched.category that flows through to setStaffCategory
      // etc.) so the user lands on the correct group.
      if (!matched) {
        for (const t of outer.innerTabs) {
          if (slugify(t.label) === innerSlug || t.value === innerSlug) {
            matched = { value: t.value, category: t.category };
            break;
          }
        }
      }
    }
    if (!matched) {
      const innerSlug = parts.slice(1).join("-");
      for (const t of outer.innerTabs) {
        if (slugify(t.label) === innerSlug || t.value === innerSlug) {
          matched = { value: t.value, category: t.category };
          break;
        }
      }
    }
    if (!matched) {
      router.replace("/", undefined, { shallow: true });
      return;
    }

    setTopTab(outerValue as any);
    if (outerValue === "worker") {
      setStaffInnerTab(matched.value as any);
      if (matched.category) setStaffCategory(matched.category);
    } else if (outerValue === "admin") {
      setStaffInnerTab(matched.value as any);
      if (matched.category) setStaffCategory(matched.category);
    } else if (outerValue === "super") {
      setStaffInnerTab(matched.value as any);
      if (matched.category) setStaffCategory(matched.category);
    } else if (outerValue === "client") {
      setClientInnerTab(matched.value as any);
    }
    // Strip only the `tab` param; preserve everything else (e.g., `docId`,
    // `typeKey`, `occ=…`) so the receiving tab can read its deep-link params.
    const rest = { ...router.query };
    delete rest.tab;
    router.replace({ pathname: "/", query: rest }, undefined, { shallow: true });
  }, [router.query.tab, isSignedIn, meLoading]);

  // Deep-link to a specific occurrence (e.g., ?occ=OCCURRENCE_ID or ?occ=OCCURRENCE_ID&view=admin)
  // Uses localStorage (not sessionStorage) so it survives OAuth redirects and page reloads.
  // Only strips the URL params after the user is authenticated and the deep link is consumed.
  // ?at=<ISO startAt> anchors the JobsTab date range on the occurrence so it
  // isn't hidden by the worker's 60-day clamp (e.g. tomorrow's job under a
  // "today" default).
  useEffect(() => {
    const occId = router.query.occ as string | undefined;
    // `?view=admin` IS NO LONGER READ. It picked between a worker and an
    // admin destination for this deep link; there is one staff tab list, so
    // both arms did the same thing — except on Equipment, where the
    // "admin" arm skipped setStaffCategory and left the category strip on
    // whatever was there. Old links carrying the param still work: it is
    // ignored rather than rejected.
    const at = router.query.at as string | undefined;
    if (occId) {
      try {
        localStorage.setItem("seedlings_deeplink_occ", occId);
        if (at) localStorage.setItem("seedlings_deeplink_at", at);
        else localStorage.removeItem("seedlings_deeplink_at");
        localStorage.setItem("seedlings_deeplink_ts", String(Date.now()));
      } catch {}
      // Only strip URL if user is already signed in; otherwise leave it
      // so Clerk can redirect back with the params intact after auth
      if (isSignedIn) {
        router.replace("/", undefined, { shallow: true });
      }
    }
  }, [router.query.occ, router.query.at, isSignedIn]);

  // Deep-link to a specific equipment item (e.g., ?equipment=ID or ?equipment=ID&view=admin)
  useEffect(() => {
    const equipmentId = router.query.equipment as string | undefined;
    if (equipmentId) {
      try {
        localStorage.setItem("seedlings_deeplink_equipment", equipmentId);
        localStorage.setItem("seedlings_deeplink_equipment_ts", String(Date.now()));
      } catch {}
      if (isSignedIn) {
        router.replace("/", undefined, { shallow: true });
      }
    }
  }, [router.query.equipment, isSignedIn]);

  // Deep-link to a CompanyDocument (`?docId=…`) or a Documents collection
  // (`?typeKey=…`). Stash to localStorage so the value survives Clerk auth,
  // then strip the URL once signed in. A separate consume-effect below
  // navigates to the right Documents tab and dispatches a custom event with
  // the deep-link payload — DocumentsTab listens for that event.
  useEffect(() => {
    const docId = router.query.docId as string | undefined;
    const typeKey = router.query.typeKey as string | undefined;
    if (docId || typeKey) {
      try {
        if (docId) localStorage.setItem("seedlings_deeplink_document", docId);
        if (typeKey) localStorage.setItem("seedlings_deeplink_document_typekey", typeKey);
        localStorage.setItem("seedlings_deeplink_document_ts", String(Date.now()));
      } catch {}
      if (isSignedIn) {
        const rest = { ...router.query };
        delete rest.docId;
        delete rest.typeKey;
        router.replace({ pathname: "/", query: rest }, undefined, { shallow: true });
      }
    }
  }, [router.query.docId, router.query.typeKey, isSignedIn]);

  // Consume the stashed Documents deep-link once auth is settled. Navigates
  // to Documents if the user is Super, else Documents. Then
  // dispatches `documentsTab:applyDeepLink` repeatedly until DocumentsTab
  // signals readiness (via window.__documentsTabReady) — same retry-pattern
  // used by the occurrence deep-link above.
  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let docId: string | null = null;
    let typeKey: string | null = null;
    try {
      docId = localStorage.getItem("seedlings_deeplink_document");
      typeKey = localStorage.getItem("seedlings_deeplink_document_typekey");
      const ts = localStorage.getItem("seedlings_deeplink_document_ts");
      // Drop stale links (older than 5 minutes) so a refresh doesn't replay.
      if (ts && Date.now() - Number(ts) > 5 * 60 * 1000) {
        docId = null;
        typeKey = null;
      }
    } catch {}
    if (!docId && !typeKey) {
      try {
        localStorage.removeItem("seedlings_deeplink_document");
        localStorage.removeItem("seedlings_deeplink_document_typekey");
        localStorage.removeItem("seedlings_deeplink_document_ts");
      } catch {}
      return;
    }
    try {
      localStorage.removeItem("seedlings_deeplink_document");
      localStorage.removeItem("seedlings_deeplink_document_typekey");
      localStorage.removeItem("seedlings_deeplink_document_ts");
    } catch {}

    // Don't override the tab the slug-resolver already routed to. If the
    // user is already sitting on Documents (admin or super), keep them
    // there and just dispatch — only choose a default when the link came
    // in without a `tab=` slug so nothing routed yet.
    // One Documents tab.
    const onDocs = topTab === "staff" && staffInnerTab === "documents";
    if (!onDocs) {
      // One tab, one capability. This was a two-arm branch on role flags
      // with two IDENTICAL bodies — the shape left over from the days when
      // super and admin had separate documents tabs to land on.
      if (scopeCan("documents.view")) {
        setTopTab("staff");
        setStaffInnerTab("documents" as any);
        setStaffCategory("Records");
      } else {
        // No documents tab visible to this role; nothing to do.
        return;
      }
    }

    const savedDocId = docId;
    const savedTypeKey = typeKey;
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__documentsTabReady || attempts >= maxAttempts) {
        clearInterval(interval);
        window.dispatchEvent(new CustomEvent("documentsTab:applyDeepLink", {
          detail: { docId: savedDocId, typeKey: savedTypeKey },
        }));
      }
    }, 100);
    return () => clearInterval(interval);
    // topTab/innerTab read at run-time intentionally — not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.isApproved, meLoading, scopeCan]);

  // Deep-link to a Timeline event (?eventId=…). Mirrors the Documents pattern:
  // stash on detect, navigate after auth, dispatch event once Timeline tab is
  // mounted and ready.
  useEffect(() => {
    const eventId = router.query.eventId as string | undefined;
    if (eventId) {
      try {
        localStorage.setItem("seedlings_deeplink_event", eventId);
        localStorage.setItem("seedlings_deeplink_event_ts", String(Date.now()));
      } catch {}
      if (isSignedIn) {
        const rest = { ...router.query };
        delete rest.eventId;
        router.replace({ pathname: "/", query: rest }, undefined, { shallow: true });
      }
    }
  }, [router.query.eventId, isSignedIn]);

  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let eventId: string | null = null;
    try {
      eventId = localStorage.getItem("seedlings_deeplink_event");
      const ts = localStorage.getItem("seedlings_deeplink_event_ts");
      if (ts && Date.now() - Number(ts) > 5 * 60 * 1000) {
        eventId = null;
      }
    } catch {}
    if (!eventId) {
      try {
        localStorage.removeItem("seedlings_deeplink_event");
        localStorage.removeItem("seedlings_deeplink_event_ts");
      } catch {}
      return;
    }
    try {
      localStorage.removeItem("seedlings_deeplink_event");
      localStorage.removeItem("seedlings_deeplink_event_ts");
    } catch {}

    // Don't override the tab the slug-resolver already routed to. If the
    // user is sitting on a Timeline tab (either admin or super), keep them
    // there and just dispatch the deep-link event. Only choose a default
    // when the link came in without a `tab=` slug (so nothing routed yet).
    // One Timeline tab.
    const onTimeline = topTab === "staff" && staffInnerTab === "timeline";
    if (!onTimeline) {
      // One tab, one capability. This was a two-arm branch on role flags
      // with two IDENTICAL bodies — the shape left over from the days when
      // super and admin had separate timeline tabs to land on.
      if (scopeCan("timeline.view")) {
        setTopTab("staff");
        setStaffInnerTab("timeline" as any);
        setStaffCategory("Records");
      } else {
        return;
      }
    }

    const savedEventId = eventId;
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__timelineTabReady || attempts >= maxAttempts) {
        clearInterval(interval);
        window.dispatchEvent(new CustomEvent("timelineTab:applyDeepLink", {
          detail: { eventId: savedEventId },
        }));
      }
    }, 100);
    return () => clearInterval(interval);
    // topTab/innerTab read at run-time intentionally — not in deps, so we
    // don't re-fire on tab navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.isApproved, meLoading, scopeCan]);

  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let occId: string | null = null;
    let anchorAt: string | null = null;
    try {
      occId = localStorage.getItem("seedlings_deeplink_occ");
      anchorAt = localStorage.getItem("seedlings_deeplink_at");
      const ts = localStorage.getItem("seedlings_deeplink_ts");
      // Discard stale deep links (older than 5 minutes)
      if (ts && Date.now() - Number(ts) > 5 * 60 * 1000) {
        occId = null;
      }
    } catch {}
    if (!occId) {
      try { localStorage.removeItem("seedlings_deeplink_occ"); localStorage.removeItem("seedlings_deeplink_view"); localStorage.removeItem("seedlings_deeplink_at"); localStorage.removeItem("seedlings_deeplink_ts"); } catch {}
      return;
    }
    try {
      localStorage.removeItem("seedlings_deeplink_occ");
      localStorage.removeItem("seedlings_deeplink_view");
      localStorage.removeItem("seedlings_deeplink_at");
      localStorage.removeItem("seedlings_deeplink_ts");
    } catch {}
    // Strip URL params now that we've consumed them
    if (router.query.occ) {
      router.replace("/", undefined, { shallow: true });
    }
    setTopTab("staff");
    setStaffInnerTab("jobs");
    setStaffCategory("Work");
    // Retry dispatching the highlight event until the JobsTab is mounted and listening.
    // JobsTab sets a flag on window when its listener is ready.
    const savedOccId = occId;
    const savedAnchor = anchorAt;
    let attempts = 0;
    const maxAttempts = 30; // 30 x 100ms = 3 seconds max
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__jobsTabReady || attempts >= maxAttempts) {
        clearInterval(interval);
        window.dispatchEvent(new CustomEvent("navigate:staffTab", { detail: { tab: "jobs" } }));
        window.dispatchEvent(new CustomEvent("jobsTab:highlightOcc", { detail: { occId: savedOccId, anchorAt: savedAnchor } }));
      }
    }, 100);
    return () => clearInterval(interval);
  }, [me?.isApproved, meLoading]);

  // Consume ?equipment=<id> deep link after auth.
  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let equipmentId: string | null = null;
    try {
      equipmentId = localStorage.getItem("seedlings_deeplink_equipment");
      const ts = localStorage.getItem("seedlings_deeplink_equipment_ts");
      if (ts && Date.now() - Number(ts) > 5 * 60 * 1000) {
        equipmentId = null;
      }
    } catch {}
    if (!equipmentId) {
      try {
        localStorage.removeItem("seedlings_deeplink_equipment");
        localStorage.removeItem("seedlings_deeplink_equipment_view");
        localStorage.removeItem("seedlings_deeplink_equipment_ts");
      } catch {}
      return;
    }
    try {
      localStorage.removeItem("seedlings_deeplink_equipment");
      localStorage.removeItem("seedlings_deeplink_equipment_view");
      localStorage.removeItem("seedlings_deeplink_equipment_ts");
    } catch {}
    if (router.query.equipment) {
      router.replace("/", undefined, { shallow: true });
    }
    setTopTab("staff");
    setStaffInnerTab("equipment");
    setStaffCategory("Equipment");
    const savedId = equipmentId;
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__equipmentTabReady || attempts >= maxAttempts) {
        clearInterval(interval);
        window.dispatchEvent(new CustomEvent("navigate:staffTab", { detail: { tab: "equipment" } }));
        window.dispatchEvent(new CustomEvent("equipmentTab:highlight", { detail: { equipmentId: savedId } }));
      }
    }, 100);
    return () => clearInterval(interval);
  }, [me?.isApproved, meLoading]);

  const goToApprovals = useCallback(() => {
    // Routes to the one Users tab. The "Pending Users" alert chip in the
    // title bar is gated on `people.approve`, the same entitlement the
    // approve action itself needs, so nobody is sent to a queue they
    // cannot clear.
    // Include `role: "all"` in the payload so the persisted role filter
    // is reset on arrival — otherwise the alert
    // would land on a screen filtered to a role the new sign-up doesn't
    // have, and the Pending section would silently show zero rows
    // despite the alert badge reading a positive count.
    window.sessionStorage.setItem("users:openOnce", JSON.stringify({ status: "pending", role: "all" }));
    setTopTab("staff");
    // The CATEGORY has to move too. Without it the category stayed
    // wherever it was, "users" didn't resolve under it, and the app fell
    // back to the wrong destination (reported 2026-08-27) — an alert
    // routing to a screen without the section it pointed at.
    setStaffCategory("Directory");
    setStaffInnerTab("users");
    // Also dispatch event for when component is already mounted
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("users:open", {
          detail: { status: "pending" as const, role: "all" as const },
        })
      );
    }, 100);
  }, []);

  const goToPaymentApprovals = useCallback(() => {
    setTopTab("staff");
    setStaffInnerTab("payments");
  }, []);

  // Jump to Workdays tab and (when there are pending approvals) point
  // the tab at the OLDEST pending day so Super starts where the
  // backlog begins. State for the jump (workdaysJumpDate / Nonce) is
  // declared near the top of the component; this just bumps it.
  const goToWorkdayApprovals = useCallback(() => {
    setTopTab("staff");
    setStaffInnerTab("workdays");
    // Jump to the oldest date across BOTH pending workdays AND pending
    // mileage. Otherwise a lone pending mileage entry (a driver who
    // logged mileage without clocking a workday — Observer scenario)
    // dumps the operator on today's tab even though the actionable
    // item is on a prior date, making the alert count feel like a
    // ghost. See also the mileage chip render on "Didn't work" rows
    // in WorkdaysTab.tsx which makes the entry actually reachable.
    const workdayOldest = pendingWorkdaysByDate[0]?.workdayDate ?? null;
    const mileageOldest = pendingMileageByDate[0]?.entryDate ?? null;
    const oldest = workdayOldest && mileageOldest
      ? (workdayOldest < mileageOldest ? workdayOldest : mileageOldest)
      : (workdayOldest ?? mileageOldest);
    setWorkdaysJumpDate(oldest);
    setWorkdaysJumpNonce((n) => n + 1);
  }, [pendingWorkdaysByDate, pendingMileageByDate]);

  // Land on Money → Ledger with the "Followups only" filter
  // pre-applied. The Ledger tab listens for this event on mount and
  // flips its filter chip on. A short timeout gives the tab content
  // a tick to mount before the event fires (event before subscribe ⇒
  // missed signal).
  const goToLedgerFollowups = useCallback(() => {
    setTopTab("staff");
    setStaffCategory("Money");
    setStaffInnerTab("ledger" as any);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("seedlings:open-ledger-followups"));
    }, 150);
  }, []);

  // Land on Money → Ledger — the Due-to-Record panel is pinned
  // at the top of that tab, so just landing there surfaces it. No deep-
  // link event needed (the panel isn't behind a filter chip).
  const goToDueToRecord = useCallback(() => {
    setTopTab("staff");
    setStaffCategory("Money");
    setStaffInnerTab("ledger" as any);
  }, []);

  // Records → Compliance. Both compliance alerts (pending
  // upload reviews, pending version approvals) land here — the tab
  // surfaces each in its own section so the operator sees both at once.
  const goToCompliance = useCallback(() => {
    setTopTab("staff");
    setStaffCategory("Records");
    setStaffInnerTab("compliance");
  }, []);

  // Profile. The worker Compliance section at the top of the
  // profile page auto-opens the sign wizard when the "Sign now" button
  // is pressed, so landing here is one click away from signing.
  const goToWorkerCompliance = useCallback(() => {
    setTopTab("staff");
    setStaffInnerTab("profile");
    setStaffCategory("System");
  }, []);

  // Stream-pause reminders — land on the Services tab where the paused
  // stream cards live. One former shell's innerTabs list had NO
  // "services" entry, so the previous
  // `setStaffInnerTab("services")` silently fell back to the Home tab
  // (Operations pulse). There is one staff shell now, so there is one
  // destination.
  //
  // Fires the review event AFTER the tab switch so ServicesTab (which
  // may not be mounted yet) has time to render. Event detail carries
  // an optional occurrenceId — when present (per-row Review click),
  // the tab expands only that occurrence's job and highlights it.
  // When absent (section arrow / title-bar alert), the tab expands
  // every reminder-due job.
  const goToStreamPauseReminders = useCallback((occurrenceId?: string) => {
    // Super HAS a services tab (navTabs → super → "services", category
    // Work). An older comment here claimed it didn't and hardcoded Admin;
    // that was true once and stopped being true when the tab was added, so
    // someone with `settings.manage` clicking this alert kept getting demoted to Admin.
    gotoOperatorSurface({ tab: "services", category: "Work" });
    // Only accept string ids — some call sites pass this handler
    // directly to onClick, which forwards a MouseEvent. Guard against
    // that so we don't stuff a MouseEvent into the occurrenceId state.
    const cleanId = typeof occurrenceId === "string" ? occurrenceId : null;
    setStreamReviewOccId(cleanId);
    setStreamReviewNonce((n) => n + 1);
  }, [gotoOperatorSurface]);

  const isDev = process.env.NEXT_PUBLIC_VERCEL_ENV !== "production" && process.env.NODE_ENV !== "production";

  return (
    <>
      {/* Client impersonation banner (`clients.view-as`) — sits above the Container so it
          spans the full viewport width and sticks to the top of every page. */}
      <ImpersonationBanner
        me={me}
        // Staff standing in the customer shell. Not a customer doing so:
        // for them it is simply their app, and a bar announcing it would
        // be telling them where they live.
        //
        // AND NOT SOMEBODY PARKED THERE. The shell effect pushes an account
        // with no reachable staff tab to `client`, so a brand-new hire with
        // no grants was shown a teal "Client — viewing customer-facing
        // pages, as a client sees them" bar. They are not a client, they
        // did not choose this view, and the bar's documented way out is the
        // role chip — which does not render for somebody holding no
        // capabilities. A label naming a choice they did not make, with no
        // exit, above a notice saying nothing has been shared with them.
        inClientShell={topTab === "client" && !me?.isClientContact && !homelessStaff}
      />
    <Container maxW="5xl" px={{ base: 3, md: 4 }} pt={3} pb={6}>
      {isDev && (
        <Box
          position="fixed"
          bottom="4"
          right="4"
          zIndex="9999"
          bg="red.solid"
          color="red.contrast"
          fontSize="sm"
          fontWeight="bold"
          px="4"
          py="1.5"
          borderRadius="full"
          shadow="lg"
          opacity="0.85"
          pointerEvents="none"
        >
          DEV
        </Box>
      )}
      <AppSplash show={!authLoaded || (isSignedIn && meLoading)} />
      <Box
        as="header"
        // THEMED, not a literal. Was `bg="#dce5d0"` — raw hex resolving through
        // no token, so the bar rendered the identical pale sage in all five
        // themes (pixel-sampled to confirm). `chrome.header` carries the
        // seasonal identity in the brand themes and stays quiet in the others.
        // The gradient is part of the original look, so it is themed rather
        // than dropped — two stops, both tokens.
        //
        // Chakra's own gradient props, NOT a hand-written
        // `linear-gradient(var(--chakra-colors-chrome-header), …)`: tokens in
        // a custom namespace are inlined per condition rather than emitted as
        // CSS variables, so that var() resolved to nothing and took the whole
        // gradient down with it — the bar rendered transparent.
        bgGradient="to-b"
        gradientFrom="chrome.header"
        gradientTo="chrome.headerAlt"
        color="chrome.headerFg"
        borderWidth="2px"
        borderColor="border.emphasis"
        px={{ base: 2.5, md: 3.5 }}
        py={{ base: 2, md: 2.5 }}
        borderRadius="md"
        // ROOM FOR THE PULL-TAB. The drawer handle hangs off the bottom
        // border (see it at the end of this block), so the header needs to
        // be the positioning context and needs a little clearance beneath
        // it. Was mb={1}.
        position="relative"
        mb={2.5}
      >
        {/* GRID header: left brand, center temp, right controls */}
        <Box
          display="grid"
          // `minmax(0, 1fr) auto`, NOT `1fr 1fr`.
          //
          // Two equal tracks give the controls half the bar whatever they
          // measure, and a grid item defaults to `min-width: auto`, so the
          // right-hand group refuses to shrink into its track and spills
          // out of it instead. On a 390px phone that pushed the avatar 12px
          // past the header's own right edge and gave the document a
          // scrollWidth of 392 — the whole page scrolled sideways.
          //
          // The controls are discrete and must not be clipped; the brand
          // and the temperature CAN give ground, and the left cell already
          // carries `minW="0"` + `overflow="hidden"` to do it. So: size the
          // right track to its content, let the left absorb the squeeze.
          gridTemplateColumns="minmax(0, 1fr) auto"
          alignItems="center"
          columnGap={2}
          minH={`${BRAND_ICON_H}px`}
          position="relative"
        >
          {/* Left: brand + alert badges */}
          <Box
            display="flex"
            alignItems="center"
            gap="8px"
            lineHeight="0"
            overflow="hidden"
            minW="0"
            style={{ transform: "translateY(1px)" }}
          >
            <style>{`
              /* Outward-only, matching every seedlings-pulse-* keyframe in
                 globals.css — see the PULSE DIRECTION note there. Was
                 0%,100%/50%, which grew the dot to 1.5x and shrank it back,
                 so this one visibly throbbed in and out while the rest of
                 the app radiated outward.

                 The ring does the pulsing now; the dot itself stays a solid,
                 fully-opaque status indicator rather than fading to 0.6 and
                 changing size, which made a 10px dot hard to read. */
              @keyframes pulse-dot {
                0% { box-shadow: 0 0 0 0 rgba(234,179,8,0.55); }
                70% { box-shadow: 0 0 0 7px rgba(234,179,8,0); }
                100% { box-shadow: 0 0 0 0 rgba(234,179,8,0); }
              }
            `}</style>
            {/* Brand cluster (leaf icon + "Seedlings" text + online-status
                dot + queued-actions count). Entire cluster is REPLACED by
                the on-clock bubble when the workday is IN_PROGRESS or
                PAUSED — the leaf, text, status dot, and queue chip all
                give up their slot to the running-clock pill until the
                worker completes their day. */}
            {!onClockActive && (
              <HStack gap="2" align="center">
                {/* Online/offline indicator is now an overlay dot on the top-right
                 *  corner of the Seedlings icon (staff only — clients have no
                 *  offline-queued actions and shouldn't see network state in the
                 *  chrome). The queue badge stays separate when count > 0 because
                 *  it shows the count number, which needs more space than a dot. */}
                <Box
                  position="relative"
                  cursor="pointer"
                  onClick={() => {
                    // Route to the CURRENT role's Home tab. Every role tree
                    // ships a `home` inner tab (Worker Home, Admin Home,
                    // Super Home; Client's default landing serves the same
                    // purpose). Preserves the current role — this is a
                    // "reset to home within where I am", not a role switch.
                    const current = getCurrentNavState();
                    const targetInner = topTab === "client" ? clientInnerTab : "home";
                    if (current.inner !== targetInner) pushNavHistory(current);
                    if (topTab === "staff") setStaffInnerTab("home" as StaffTabs);
                    // Client tab tree has no "home" value — the tab stays
                    // where it is (no-op).
                  }}
                  _hover={{ opacity: 0.8 }}
                >
                  {/* Show "Seedlings" text only when the user actually IS a
                      client — either not signed in, or signed in with no
                      staff role. A staff user (staff) who
                      switches to the Client tab is a preview, not an
                      actual client; keep the leaf-only look. */}
                  <BrandLabel
                    size={BRAND_ICON_H}
                    showText={!hasAnyRole}
                    showUserControls={false}
                  />
                </Box>
                {hasAnyRole && queueCount > 0 && (
                  <Box
                    as="button"
                    aria-label={`${queueCount} pending offline action${queueCount !== 1 ? "s" : ""}`}
                    title={`${queueCount} pending offline action${queueCount !== 1 ? "s" : ""}`}
                    onClick={(e: any) => { e.stopPropagation(); setQueueDialogOpen(true); }}
                    width="18px"
                    height="18px"
                    minW="18px"
                    borderRadius="9999px"
                    bg="purple.solid"
                    color="purple.contrast"
                    fontSize="10px"
                    fontWeight="bold"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    _hover={{ bg: "purple.600" }}
                    _active={{ transform: "translateY(1px)" }}
                  >
                    {queueCount}
                  </Box>
                )}
              </HStack>
            )}
            {/* On-the-clock bubble — mounted only for staff (
                super) since /api/me/workday/today is staff-only and would
                403 in a loop for pure client accounts. Renders visible pill
                only when IN_PROGRESS or PAUSED; when it does, it sits
                where the brand cluster would (brand cluster is hidden). */}
            {hasAnyRole && (
              <OnClockBubble
                isSignedIn={!!isSignedIn}
                isClientImpersonating={!!me?.isClientImpersonating}
                meId={me?.id}
                onActiveChange={setOnClockActive}
              />
            )}
            {/* Weather chip — small current-temp + icon. Lives on the LEFT
                to the right of the brand (or on-clock bubble). Click cycles
                the forecast bar below through hidden → collapsed → expanded
                → hidden. Renders whenever weather data is known regardless
                of role (clients can use it too). */}
            {titleWeather != null && (
              <Box
                as="button"
                cursor="pointer"
                px="2"
                py="1"
                borderRadius="md"
                bg="blue.faint"
                color="blue.fg"
                _hover={{ bg: "blue.subtle" }}
                title={
                  weatherMode === "hidden"
                    ? "Weather — click to show forecast bar"
                    : weatherMode === "collapsed"
                    ? "Weather — click to expand the forecast bar"
                    : "Weather — click to hide the forecast bar"
                }
                aria-label="Toggle weather forecast bar"
                onClick={cycleWeatherMode}
                display="inline-flex"
                alignItems="center"
                gap="1"
                flexShrink={0}
              >
                <WeatherIcon icon={titleWeather.icon} size={14} />
                <Text fontSize="sm" fontWeight="semibold" lineHeight="1" whiteSpace="nowrap">
                  {Math.round(titleWeather.temp)}°
                </Text>
                {/* Glyph only — the title bar has a few pixels to spare. The
                    event name is in the tooltip; the weather bar below has
                    the readable version. */}
                <WeatherAlertBadge alerts={titleAlerts} density="icon" />
              </Box>
            )}
          </Box>

          {/* Right: badges + worker type + Clerk */}
          <div
            style={{
              justifySelf: "end",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              lineHeight: 0,
              minHeight: `${BRAND_ICON_H}px`,
              // Belt and braces with the `auto` track above: if this group
              // ever does have to shrink, let it, rather than overflowing
              // the header the way it did before.
              minWidth: 0,
            }}
          >
            {/* Earnings pill — DISABLED (may return). Previously a green
                cycle-through-period money chip (Today / Wk / Mo). Was
                pulled in favor of the "on the clock" duration bubble
                below because workers not ending their workdays was a
                bigger operational issue than making running totals
                more visible in the header. All the supporting fetch +
                cycle plumbing (fetchEarnings / EARNINGS_PERIODS /
                cycleEarningsPeriod / setEarnings etc.) is kept intact
                for a straight re-enable — just uncomment this block if
                the earnings chip needs to come back.
            {earnings != null && !me?.isClientImpersonating && (
              <Box
                as="button"
                cursor="pointer"
                px="2"
                py="1"
                borderRadius="md"
                bg="green.faint"
                color="green.fg"
                _hover={{ bg: "green.subtle" }}
                title={`Earnings (${EARNINGS_LABELS[earningsPeriod]}) — click to cycle period`}
                onClick={cycleEarningsPeriod}
              >
                <Text fontSize="sm" fontWeight="semibold" lineHeight="1" whiteSpace="nowrap">
                  ${fmtEarnings(earnings[earningsPeriod])}
                  <Text as="span" fontSize="2xs" fontWeight="medium" color="green.fg" ml={1}>{EARNINGS_LABELS[earningsPeriod]}</Text>
                </Text>
              </Box>
            )}
            */}

            {/* Role selector — renders BEFORE the alerts badge so the
                order reads: role → alerts → avatar. Hidden when the user
                has zero or one role; multi-role users get a compact chip
                + dropdown. Switching preserves the current inner tab
                when the same tab exists in the target role. */}
            {/* The theme switcher USED TO SIT HERE. It is in the header
                drawer now (the chevron at the end of this row): a
                preference people set once and then never touch was holding
                32px of the title bar on every screen of every session. */}
            {/* The PORTFOLIO LENS — "show me only Durham", for somebody entitled
                to see more. Sits before the perspective chip because the two
                narrow different axes and read left to right as WHERE then
                WHO: a perspective narrows what you may do, this narrows
                where you are looking, and they combine freely. Renders
                nothing unless there are at least two portfolios this person can
                choose between. */}
            {mounted && isSignedIn && hasAnyRole && <PortfolioLensChip />}
            {/* The perspective picker. This slot held a shell switcher
                listing one entry per role, deciding
                which build of every tab you saw. One staff tab list means
                there are no shells to switch, and this is where people
                reach to change who they are looking as. */}
            {mounted && isSignedIn && hasAnyRole && (
              <RoleChip
                inClientShell={topTab === "client" && !me?.isClientContact}
                perspectives={(me?.perspectives ?? []).map((p) => ({
                  roleId: p.roleId,
                  name: p.name,
                  icon: p.icon ?? null,
                }))}
                activeRoleId={me?.activePerspectiveRoleId ?? null}
                onPick={(roleId, name) => {
                  // A LENS ONLY MEANS ANYTHING IN THE STAFF APP, so picking
                  // one from the customer shell goes back there and applies
                  // it in one action. Otherwise the row would appear to do
                  // nothing: the customer pages are gated on being a client
                  // contact, not on any capability, so narrowing the
                  // capability set changes not one pixel of them.
                  if (topTab === "client") switchRole("staff");
                  void setPerspective(roleId, name);
                }}
                otherShell={
                  // ANY STAFF MEMBER, not only one who is also a customer.
                  //
                  // It was gated on `isClientContact`, which hid the entry
                  // from everybody who is purely staff — and the customer
                  // portal is where Community, Services and Promotions
                  // live, none of which is gated on anything. Those are the
                  // public-facing pages, and being able to go and look at
                  // them is the whole reason this entry was always present
                  // before the shells collapsed from four to two.
                  //
                  // ONE LABEL, BOTH WAYS. It used to read "Switch to staff
                  // view" once you were in the customer shell — the only
                  // row in the menu naming a journey rather than a place,
                  // and it turned the control into a different control
                  // depending on where you stood. The row is the
                  // destination now; RoleChip marks it as the current one
                  // when you are there, exactly as it marks a lens.
                  //
                  // What a customer sees and what staff see still differ —
                  // a customer gets their own portal with My Properties and
                  // Statements, staff get the public pages only — but that
                  // is a fact about the destination, not two destinations.
                  anyTabVisible(staffTabs)
                    ? {
                        label: "Client",
                        onSwitch: () => switchRole("client"),
                      }
                    : undefined
                }
              />
            )}
            {/* Combined alert badge — staff only. Clients have no alerts
             *  (no Pending Users / Pending Payments / Unclaimed jobs /
             *  Planning / Timeline). Without this gate, clients see a
             *  pulsating red loading dot that never resolves. */}
            {isSignedIn && hasAnyRole && !alertsReady && (
              <Box
                width="24px"
                height="24px"
                minW="24px"
                borderRadius="9999px"
                bg="red.solid"
                display="flex"
                alignItems="center"
                justifyContent="center"
                style={{ animation: "alert-pulse 1.2s ease-in-out infinite" }}
              >
                <style>{`@keyframes alert-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.9); } }`}</style>
                <Box w="6px" h="6px" borderRadius="full" bg="bg.panel" />
              </Box>
            )}
            {hasAnyRole && alertsReady && (() => {
              // Each alert asks for the capability of the QUEUE IT OPENS.
              // They keyed off three scoped role flags —
              // so someone with `settings.manage` acting as Worker doesn't see management
              // alerts they can't act on from the current tab. See the
              // scope var definitions near the top of this component.
              const alerts: { label: string; count: number; bg: string; color: string; dotColor: string; onClick: () => void }[] = [];
              if (scopeCan("schedule.manage") && overdueCount > 0) alerts.push({ label: "Job Overdue", count: overdueCount, bg: "#FEE2E2", color: "#991B1B", dotColor: "#EF4444", onClick: goToOverdue });
              // Sits next to Job Overdue because they are the same rule split
              // by workflow — an operator reading "3 / 2" should see at a
              // glance that those are five late things, in two queues.
              if (scopeCan("schedule.manage") && activitiesOverdueCount > 0) alerts.push({ label: "Activities Overdue", count: activitiesOverdueCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToActivitiesOverdue });
              if (scopeCan("people.approve") && pending > 0) alerts.push({ label: "Pending Users", count: pending, bg: "#FFEDD5", color: "#9A3412", dotColor: "#FB923C", onClick: goToApprovals });
              // Payments to review — combined alert that rolls up
              // pending-admin-approval payments + outstanding client
              // payment requests. Both used to be separate entries
              // that routed to the same Payments tab, so we
              // collapsed them into a single, generically-named item.
              // Stale-aware color: when ANY outstanding request has
              // aged past the threshold, the alert switches to orange
              // tones as a visual prompt to follow up — same logic
              // the old "Awaiting payment" entry used.
              if (scopeCan("money.approve")) {
                const paymentsToReview = pendingPayments + awaitingClientPaymentCount;
                if (paymentsToReview > 0) {
                  alerts.push({
                    label: "Payments to review",
                    count: paymentsToReview,
                    bg: staleRequestCount > 0 ? "#FFEDD5" : "#DCFCE7",
                    color: staleRequestCount > 0 ? "#9A3412" : "#14532D",
                    dotColor: staleRequestCount > 0 ? "#FB923C" : "#16A34A",
                    onClick: goToPaymentApprovals,
                  });
                }
              }
              // Combined "workdays to review" — count is hours + mileage
              // but the label stays workday-centric because the click
              // drops onto the WorkdaysTab where each row shows both
              // categories side-by-side.
              if (scopeCan("people.approve") && pendingWorkdays + pendingMileage > 0) {
                alerts.push({
                  // Combined count intentionally — workdays + mileage
                  // share the same drill-in (Workdays tab, with mileage
                  // sub-rows). Label mentions both so a lone pending
                  // mileage entry doesn't read as a phantom "Workday to
                  // review." See goToWorkdayApprovals which now also
                  // jumps to the correct date whichever source has the
                  // oldest.
                  label: "Workdays / mileage to review",
                  count: pendingWorkdays + pendingMileage,
                  bg: "#E0E7FF",
                  color: "#3730A3",
                  dotColor: "#6366F1",
                  onClick: goToWorkdayApprovals,
                });
              }
              if (scopeCan("books.manage") && ledgerFollowupCount > 0) alerts.push({ label: "Ledger followups", count: ledgerFollowupCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToLedgerFollowups });
              if (scopeCan("money.record") && dueToRecordCount > 0) alerts.push({ label: "Due to record", count: dueToRecordCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToDueToRecord });
              if (scopeCan("schedule.manage") && streamPauseRemindersCount > 0) alerts.push({ label: "Paused repeating to review", count: streamPauseRemindersCount, bg: "#F3E8FF", color: "#6B21A8", dotColor: "#A855F7", onClick: goToStreamPauseReminders });
              // Next-visit placeholders. Gray on purpose — it's the ghost
              // card's own color, so the alert and the cards it lands on
              // read as the same thing. Expired is the darker of the two.
              if (scopeCan("schedule.manage") && ghostExpiringCount > 0) alerts.push({ label: "Next visits expiring", count: ghostExpiringCount, bg: "#F3F4F6", color: "#374151", dotColor: "#6B7280", onClick: goToExpiringGhosts });
              // Slate grey, not near-black. It was #374151, which sits at
              // 1.72:1 against the black total-count circle above it — the
              // two read as the same colour. #6b7280 is 3.67:1 from that
              // black while keeping the white numeral at 4.83:1, and it is
              // in the same family as the grey ghost cards it points at.
              if (scopeCan("schedule.manage") && ghostExpiredCount > 0) alerts.push({ label: "Next visits expired", count: ghostExpiredCount, bg: "#E5E7EB", color: "#111827", dotColor: "#6b7280", onClick: goToExpiredGhosts });
              if (scopeCan("compliance.manage") && policyPendingUploadsCount > 0) alerts.push({ label: "Compliance uploads to review", count: policyPendingUploadsCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToCompliance });
              if (scopeCan("compliance.manage") && policyPendingApprovalsCount > 0) alerts.push({ label: "Policy versions awaiting approval", count: policyPendingApprovalsCount, bg: "#DBEAFE", color: "#1E3A8A", dotColor: "#3B82F6", onClick: goToCompliance });
              // "Documents to sign" is a per-user obligation, so it
              // surfaces on any tab where the user is authenticated as
              // themselves — everyone on staff signs policies, whatever they hold.
              // No scope gate.
              if (policyWorkerPendingCount > 0) alerts.push({ label: "Documents to sign", count: policyWorkerPendingCount, bg: "#FEE2E2", color: "#7F1D1D", dotColor: "#DC2626", onClick: goToWorkerCompliance });
              if (scopeCan("schedule.manage") && changeRequestCount > 0) alerts.push({ label: "Client requests", count: changeRequestCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToClientRequests });
              if (scopeCan("identity.link") && unlinkedAccountsCount > 0) alerts.push({ label: "Unlinked client accounts", count: unlinkedAccountsCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToUnlinkedAccounts });
              if (scopeCan("estimates.create") && estimateFollowupCount > 0) alerts.push({ label: "Estimate follow-ups", count: estimateFollowupCount, bg: "#FCE7F3", color: "#9D174D", dotColor: "#EC4899", onClick: goToEstimateFollowups });
              // The two payroll queues sit together: this one blocks a
              // worker from seeing their pay, the next holds hours back
              // from the Gusto export. Purple matches the Payroll tab's
              // employer-cost accent, so the colour reads as "payroll"
              // rather than as a severity.
              if (scopeCan("payroll.manage") && payrollUnmatchedCount > 0) alerts.push({ label: "Payroll names to match", count: payrollUnmatchedCount, bg: "#F3E8FF", color: "#6B21A8", dotColor: "#A855F7", onClick: goToPayrollIdentities });
              // Blue: reviewing training material is a content task, not an
              // operational warning — orange is spoken for by the queues that
              // block someone from being paid or doing their job.
              if (scopeCan("content.approve") && guideApprovalCount > 0) alerts.push({ label: "Guides awaiting approval", count: guideApprovalCount, bg: "#DBEAFE", color: "#1E3A8A", dotColor: "#3B82F6", onClick: goToGuideApprovals });
              if (scopeCan("time.approve") && unapprovedHoursCount > 0) alerts.push({ label: "Job hours awaiting review", count: unapprovedHoursCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToUnapprovedHours });
              if (scopeCan("schedule.manage") && unclaimedCount > 0) alerts.push({ label: "Unclaimed", count: unclaimedCount, bg: "#FEF9C3", color: "#713F12", dotColor: "#FACC15", onClick: goToUnclaimed });
              // Announcements are for anyone who can see the schedule.
              // so acting as a client hides them, but they surface for
              // staff scopes.
              if (scopeCan("schedule.view") && announcementCount > 0) alerts.push({ label: "Announcements", count: announcementCount, bg: "#EDE9FE", color: "#4C1D95", dotColor: "#6D28D9", onClick: goToAnnouncements });
              if (scopeCan("timeline.view") && timelineUrgentCount > 0) alerts.push({ label: "Timeline", count: timelineUrgentCount, bg: "#E0E7FF", color: "#3730A3", dotColor: "#6366F1", onClick: goToTimeline });
              if (alerts.length === 0) return null;
              const total = alerts.reduce((s, a) => s + a.count, 0);
              const topAlert = alerts[0]; // highest priority for badge color
              return (
                <Box position="relative">
                  <Box
                    as="button"
                    data-alert-badge
                    aria-label={alertsRefreshing ? "Refreshing alerts" : `${total} alert${total !== 1 ? "s" : ""}`}
                    onClick={() => setAlertDropdownOpen((p: boolean) => !p)}
                    width="24px"
                    height="24px"
                    minW="24px"
                    borderRadius="9999px"
                    fontSize="12px"
                    fontWeight="bold"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    _hover={{ opacity: 0.9 }}
                    _active={{ transform: "translateY(1px)" }}
                    // While the dropdown's Refresh action is in-flight, the
                    // bell badge reverts to the same pulsing-white-dot look
                    // used for the initial !alertsReady state. Same red bg,
                    // same alert-pulse keyframe — so the user can immediately
                    // tell the count is stale and being re-fetched.
                    style={{
                      background: "#EF4444",
                      color: "#fff",
                      animation: alertsRefreshing ? "alert-pulse 1.2s ease-in-out infinite" : undefined,
                    }}
                  >
                    {alertsRefreshing ? (
                      <Box w="6px" h="6px" borderRadius="full" bg="bg.panel" />
                    ) : (
                      total
                    )}
                  </Box>
                  {alertDropdownOpen && (
                    <VStack
                      data-alert-dropdown
                      position="fixed"
                      bg="bg.panel"
                      borderWidth="1px"
                      borderColor="gray.emphasized"
                      rounded="md"
                      shadow="lg"
                      zIndex={10001}
                      p={1}
                      gap={0}
                      minW="200px"
                      ref={(el: HTMLDivElement | null) => {
                        if (el && el.parentElement) {
                          const rect = el.parentElement.getBoundingClientRect();
                          el.style.top = `${rect.bottom + 6}px`;
                          el.style.right = `${window.innerWidth - rect.right}px`;
                        }
                      }}
                    >
                      {/* "Tasks" — opens the consolidated worklist
                          page. Sits above the per-alert deep-links so
                          it's the first thing the operator sees; the
                          per-alert jumps remain for people who want to
                          land directly in a specific tab's context.
                          Hidden from clients (no role to act). The
                          right-side Refresh button shares this row so
                          the manual-recount affordance is reachable
                          without scrolling to the bottom — was a
                          separate trailing row before. */}
                      {hasAnyRole && (
                        <>
                          <HStack w="full" gap={1}>
                            <Button
                              size="sm"
                              variant="ghost"
                              flex={1}
                              justifyContent="start"
                              gap={2}
                              onClick={() => {
                                setAlertDropdownOpen(false);
                                setTasksOpen((v) => !v);
                              }}
                            >
                              <Box
                                w="22px" h="22px" minW="22px" borderRadius="full"
                                display="flex" alignItems="center" justifyContent="center"
                                flexShrink={0}
                                style={{ background: "#0F172A", color: "#fff" }}
                              >
                                {total}
                              </Box>
                              <Text flex="1" textAlign="left" fontWeight="semibold">
                                {tasksOpen ? "Close Tasks" : "Tasks"}
                              </Text>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              color="fg.muted"
                              flexShrink={0}
                              minW="32px"
                              px={2}
                              disabled={alertsRefreshing}
                              onClick={(e) => { e.stopPropagation(); void refreshAllAlerts(); }}
                              aria-label="Refresh counts"
                              title="Refresh counts"
                            >
                              {alertsRefreshing ? <Spinner size="xs" /> : <FiRefreshCw size={14} />}
                            </Button>
                          </HStack>
                          <Box w="full" h="1px" bg="gray.muted" my={1} />
                        </>
                      )}
                      {alerts.map((a) => (
                        <Button
                          key={a.label}
                          size="sm"
                          variant="ghost"
                          w="full"
                          justifyContent="start"
                          gap={2}
                          // Dim + disable each entry while a refresh is
                          // in-flight so the operator sees the dropdown is
                          // stale and can't click into a count that may be
                          // about to change.
                          opacity={alertsRefreshing ? 0.45 : 1}
                          disabled={alertsRefreshing}
                          onClick={() => { setAlertDropdownOpen(false); a.onClick(); }}
                        >
                          <Box
                            w="22px" h="22px" minW="22px" borderRadius="full"
                            fontSize="12px" fontWeight="bold"
                            display="flex" alignItems="center" justifyContent="center"
                            flexShrink={0}
                            style={{ background: a.dotColor, color: a.dotColor === "#FACC15" ? "#713F12" : "#fff" }}
                          >
                            {a.count}
                          </Box>
                          <Text flex="1" textAlign="left">{a.label}</Text>
                        </Button>
                      ))}
                    </VStack>
                  )}
                </Box>
              );
            })()}
            {/* `isClientContact`, NOT "holds no capabilities".
                This read `!hasAnyRole`, which is a different question with
                the same answer most of the time — and the exception is the
                one that matters: a staff account nobody has granted
                anything to yet. A new hire signing in for the first time
                was labelled Client in their own header.
                CLAUDE.md is explicit that the customer boundary is an
                ACTIVE ClientContact for the Clerk id, and that it never
                consults roles. A real client contact holds no capabilities
                anyway — the payroll gate sees to that — so this is strictly
                narrower, not a widening. */}
            {isSignedIn && me?.isClientContact && me?.isApproved && (
              <Badge size="sm" variant="subtle" colorPalette="green" lineHeight="normal">
                Client
              </Badge>
            )}
            {/* Staff get a custom avatar that navigates to the in-app
                Profile tab (where Manage Account + Sign Out live). Clients
                still see Clerk's UserButton because they don't have an
                in-app Profile page to land on. Online/offline status dot
                overlays the avatar's top-right corner (the leaf-icon
                overlay it used to sit on is hidden while on-clock; the
                avatar is always present, so this is the stable spot). */}
            {mounted && isSignedIn && hasAnyRole ? (
              <Box position="relative" flexShrink={0} display="inline-flex">
                <Box
                  as="button"
                  aria-label="Open profile"
                  title="Profile"
                  onClick={() => {
                    const current = getCurrentNavState();
                    // Compared `outer` against "worker", which `outer` can
                    // never be — so this always pushed, even when already
                    // sitting on Profile.
                    if (current.outer !== "staff" || current.inner !== "profile") {
                      pushNavHistory(current);
                    }
                    setTopTab("staff");
                    setStaffInnerTab("profile" as any);
                  }}
                  width="28px"
                  height="28px"
                  borderRadius="full"
                  overflow="hidden"
                  bg="gray.muted"
                  color="gray.fg"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  cursor="pointer"
                  _hover={{ opacity: 0.85 }}
                >
                  {clerkUser?.imageUrl ? (
                    <img
                      src={clerkUser.imageUrl}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <Text fontSize="xs" fontWeight="semibold">
                      {(
                        (clerkUser?.firstName?.[0] ?? "") +
                        (clerkUser?.lastName?.[0] ?? "")
                      ).toUpperCase() || "?"}
                    </Text>
                  )}
                </Box>
                <Box
                  position="absolute"
                  top="-2px"
                  right="-2px"
                  w="10px"
                  h="10px"
                  borderRadius="full"
                  bg={isOffline ? (isForceOffline ? "orange.strong" : "red.strong") : queueCount > 0 ? "yellow.strong" : "green.strong"}
                  borderWidth="2px"
                  borderColor="white"
                  cursor="pointer"
                  _hover={{ transform: "scale(1.3)" }}
                  transition="transform 0.1s"
                  onClick={(e: any) => { e.stopPropagation(); setNetworkInfoOpen(true); }}
                  style={!isOffline && queueCount > 0 ? { animation: "pulse-dot 1.2s ease-in-out infinite" } : undefined}
                  aria-label={isOffline ? (isForceOffline ? "Forced offline" : "Offline") : queueCount > 0 ? "Online — actions syncing" : "Online"}
                  title={isOffline ? (isForceOffline ? "Forced offline" : "Offline") : queueCount > 0 ? "Online — actions syncing" : "Online"}
                />
              </Box>
            ) : mounted && isSignedIn ? (
              <UserButton
                appearance={{
                  elements: {
                    rootBox: { display: "flex", alignItems: "center" },
                    userButtonBox: { display: "flex", alignItems: "center" },
                    userButtonTrigger: {
                      display: "flex",
                      alignItems: "center",
                      padding: 0,
                    },
                    userButtonAvatarBox: {
                      display: "flex",
                      alignItems: "center",
                    },
                  },
                }}
              />
            ) : mounted && !isSignedIn ? (
              // Route to our custom /sign-in page (unified flow with
              // password-first when the user has one) instead of Clerk's
              // stock modal. See BrandLabel.tsx for the same change.
              <Link href="/sign-in" legacyBehavior>
                <Text
                  as="a"
                  fontSize="sm"
                  color="blue.fg"
                  cursor="pointer"
                  _hover={{ textDecoration: "underline" }}
                >
                  Sign in
                </Text>
              </Link>
            ) : null}
          </div>
        </Box>

        {/* THE HEADER DRAWER — a second row, only when asked for.
            Labelled, because an icon that is hidden by default cannot teach
            itself: nobody builds a habit for a control they see once a
            month, so the words carry it. */}
        {mounted && isSignedIn && headerDrawerOpen && (
          <Box
            data-testid="header-drawer"
            mt={2}
            pt={2}
            borderTopWidth="1px"
            borderColor="blackAlpha.200"
            display="flex"
            alignItems="center"
            gap={4}
            flexWrap="wrap"
            // The strip above sets lineHeight 0 to close the gaps between
            // its icons; this row has words in it and needs one back. The
            // same note is on ThemeChip's dropdown panel, for the same
            // reason, and it bit twice before being written down.
            lineHeight="normal"
          >
            {/* The label goes INTO each control, not beside it — a caption
                that is not part of the button is the one place a click does
                nothing, and it is the bigger target of the two. */}
            <ThemeChip label="Appearance" />
            {scopeCan("schedule.view") && topTab !== "client" && (
              <DayBoardButton userId={me?.id ?? null} label="Today’s board" />
            )}
          </Box>
        )}

        {/* THE DRAWER HANDLE — a pull-tab straddling the bottom border.
            IT COSTS THE ROW NOTHING. As an item in the control strip it was
            20px that every other control had to give up, on every screen,
            to reach two things most people touch once. Absolutely
            positioned it is out of the flow entirely: the strip measures
            exactly as it would with no drawer at all.
            Centred, because the middle of the bar is the one stretch that
            is empty at every width — the brand sits left, the controls
            right, and on a phone where the two nearly meet the tab is below
            the border rather than between them.
            Anchored to the HEADER, not the strip, so it rides down to the
            new bottom edge when the drawer opens and always reads as the
            handle for whatever is currently showing. */}
        {mounted && isSignedIn && (
          <Box
            as="button"
            aria-label={headerDrawerOpen ? "Hide extra controls" : "Show extra controls"}
            aria-expanded={headerDrawerOpen}
            title={headerDrawerOpen ? "Hide extra controls" : "Show extra controls"}
            data-testid="header-drawer-toggle"
            onClick={() => setHeaderDrawerOpen((v: boolean) => !v)}
            position="absolute"
            left="50%"
            bottom="-2px"
            transform="translate(-50%, 50%)"
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            width="34px"
            height="16px"
            borderRadius="full"
            borderWidth="2px"
            borderColor="border.emphasis"
            bg="chrome.headerAlt"
            color="chrome.headerFg"
            cursor="pointer"
            opacity={0.9}
            _hover={{ opacity: 1 }}
            transition="opacity 0.1s"
            zIndex={1}
          >
            <Box
              as="span"
              display="inline-flex"
              style={{
                transform: headerDrawerOpen ? "rotate(180deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <ChevronDown size={13} />
            </Box>
          </Box>
        )}
      </Box>
      {/* Only ask for geolocation when the signed-in user is an approved
          staff. Also skipped entirely for pure client
          accounts — the /api/weather/* endpoints are staff-only and would
          403 in a loop; weather in the client-shell was aspirational
          rather than actually supported by the API.
          Gated behind `mounted` because WeatherBar's visibility depends on
          `weatherMode` (usePersistedState) — server renders the default
          "hidden" (returns null), client's first render reads the persisted
          value from localStorage which may not be "hidden" (returns a
          div). The mount gate defers WeatherBar to after hydration so
          server and client emit identical HTML on the first pass. */}
      {/* The weather strip reads `/api/weather/location`, which sits behind
          `schedule.view` — it is there for people who are going outside.
          Gated on `hasAnyRole` it also mounted for a bookkeeper and 403'd. */}
      {mounted && scopeCan("schedule.view") && (
        <WeatherBar
          // Gate the geolocation permission prompt on splashDone so
          // the browser dialog doesn't cover the splash animation.
          // Same on .team and .pro — the flag is time-based, not
          // domain-based, so both domains benefit.
          allowGeolocation={splashDone && !!me?.isApproved && scopeCan("schedule.view")}
          mode={weatherMode}
          onModeChange={setWeatherMode}
        />
      )}
      {/* Error banner when /api/me failed or timed out. Signed-in
          user with no profile = something is broken upstream (Neon
          cold, network hiccup). Renders a retryable banner in the
          content portfolio so the app is never a blank green header.
          Suppressed when offline — the existing offline indicator
          (status dot + OfflineQueueDialog) already tells the user
          why nothing is loading; a red "couldn't load profile"
          banner would just add noise. */}
      {!meLoading && isSignedIn && meError && !me && !isOffline && (
        <Box mx={3} mt={3}>
          <Box
            borderWidth="1px"
            borderColor="red.emphasized"
            bg="red.faint"
            borderRadius="md"
            p={4}
          >
            <VStack align="start" gap={3}>
              <VStack align="start" gap={1}>
                <Text fontSize="sm" fontWeight="semibold" color="red.fg">
                  Couldn&apos;t load your profile
                </Text>
                <Text fontSize="xs" color="red.fg">
                  {meError.kind === "timeout" && `The request took longer than ${Math.round(meError.elapsedMs / 1000)}s and was aborted client-side. The server never responded.`}
                  {meError.kind === "http" && `The server returned HTTP ${meError.status}: ${meError.message}`}
                  {meError.kind === "network" && `Network error: ${meError.message}`}
                  {meError.kind === "unknown" && meError.message}
                </Text>
              </VStack>
              <Box
                bg="bg.panel"
                borderWidth="1px"
                borderColor="red.emphasized"
                borderRadius="sm"
                p={2}
                w="full"
                fontSize="10px"
                fontFamily="mono"
                color="red.fg"
                whiteSpace="pre-wrap"
                overflowX="auto"
              >
{`kind:      ${meError.kind}
endpoint:  ${meError.endpoint}
status:    ${meError.status ?? "(no response)"}
elapsed:   ${meError.elapsedMs}ms
started:   ${meError.timestamp}
message:   ${meError.message}${meError.responseBody ? `
body:      ${meError.responseBody.split("\n").slice(0, 6).join("\n           ")}` : ""}`}
              </Box>
              <HStack gap={2}>
                <Button size="sm" colorPalette="red" onClick={() => void loadMe()}>
                  Try again
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  colorPalette="red"
                  onClick={() => {
                    const payload = JSON.stringify(meError, null, 2);
                    void navigator.clipboard?.writeText(payload).catch(() => {});
                  }}
                >
                  Copy details
                </Button>
              </HStack>
            </VStack>
          </Box>
        </Box>
      )}
      {!meLoading && me && !me.isApproved && <AwaitingApprovalNotice />}
      {/* An approved account that no capability lets into any tab. Was
          gated on `topTab !== "client"`, which meant it never rendered:
          the redirect effect pushes a person with no surface to the client
          shell, so the one population this notice exists for was always
          excluded from it. `isClientContact` is what separates a real
          customer (who belongs on the client shell) from a staff account
          nobody has granted anything to. */}
      {/* Not during a client "View as" session: `/api/me` answers with no
          capabilities there, so this read as "granted nothing" and put a
          no-access notice over the customer's portal. */}
      {homelessStaff && <NoRoleNotice />}
      {/* Tasks page — orthogonal worklist surface. Takes over the
          BreadcrumbNav slot when open; closing returns the operator to
          the exact tab they were on (state never gets cleared). The
          role pills are intentionally hidden while Tasks is rendered so
          this reads as a distinct portfolio of the app, not a tab. */}
      {authLoaded && (!isSignedIn || me) && tasksOpen && hasAnyRole && (
        <TasksPage
          // `can` and nothing else. This also passed three scoped role
          // flags, and TasksPage sorted its sections by them — so a
          // section was shown or hidden by which of three buckets the
          // person fell into rather than by whether they can work the
          // queue it opens.
          can={scopeCan}
          counts={{
            pendingWorkdays,
            unapprovedHoursCount,
            ledgerFollowupCount,
            dueToRecordCount,
            streamPauseRemindersCount,
            ghostExpiringCount,
            ghostExpiredCount,
            pendingUsersCount: pending,
            estimateFollowupCount,
            overdueCount,
            activitiesOverdueCount,
            unclaimedCount,
            timelineUrgentCount,
            announcementCount,
            policyPendingUploadsCount,
            policyPendingApprovalsCount,
            policyWorkerPendingCount,
            payrollUnmatchedCount,
            guideApprovalCount,
          }}
          handlers={{
            goToWorkdayApprovals,
            goToUnapprovedHours,
            goToLedgerFollowups,
            goToDueToRecord,
            goToCompliance,
            goToWorkerCompliance,
            goToPayrollIdentities,
            goToGuideApprovals,
            goToStreamPauseReminders,
            goToExpiringGhosts,
            goToExpiredGhosts,
            goToApprovals,
            goToEstimateFollowups,
            goToOverdue,
            goToActivitiesOverdue,
            goToUnclaimed,
            goToTimeline,
            goToPaymentApprovals,
            goToClientRequests,
            goToUnlinkedAccounts,
            goToAnnouncements,
          }}
          onClose={() => setTasksOpen(false)}
        />
      )}
      {authLoaded && (!isSignedIn || me) && !tasksOpen && !homelessStaff && (
        <>
        {/* "SHOWING DURHAM ONLY" — one notice for the whole app, ABOVE the
            tab row, so it reads as a condition on everything below rather
            than as a property of the open tab.
            BEFORE this element, never after: BreadcrumbNav renders the
            active tab's content as its own CHILD, so a sibling placed after
            it lands below the entire page. That is where this first went —
            y=1305 on a 1376px page — and it read as a flicker, because
            switching tabs changed the content height and slid the strip in
            and out of view at the bottom. */}
        {mounted && isSignedIn && hasAnyRole && topTab !== "client" && (
          <PortfolioScopeNotice portfolioScope={(me as any)?.portfolioScope ?? null} />
        )}
        <BreadcrumbNav
            contentGeneration={contentGeneration}
          outerTabs={navTabs}
          outerValue={topTab}
          hideOuterTab
          onOuterChange={(v: string) => {
            if (v !== topTab) pushNavHistory(getCurrentNavState());
            setTopTab(v as typeof topTab);
          }}
          innerValue={
            topTab === "client" ? clientInnerTab
            : topTab === "staff" ? staffInnerTab
            : staffInnerTab
          }
          onInnerChange={(v: string, newOuter?: string) => {
            const outer = newOuter ?? topTab;
            const current = getCurrentNavState();
            if (v !== current.inner || outer !== current.outer) pushNavHistory(current);
            if (outer === "client") setClientInnerTab(v as ClientTabs);
            else if (outer === "worker") {
              setStaffInnerTab(v as StaffTabs);
              // Only clear workflow state on manual user navigation, not programmatic
              if (!programmaticNavRef.current && v !== "routes" && v !== "equipment" && v !== "jobs") {
                try {
                  localStorage.removeItem("seedlings_planWorkday_paused");
                  localStorage.removeItem("seedlings_planWorkday");
                  localStorage.removeItem("seedlings_beginWorkday_paused");
                  localStorage.removeItem("seedlings_beginWorkday");
                } catch {}
                setActiveWorkflow(null);
              }
            }
            else setStaffInnerTab(v as StaffTabs);
          }}
          categoryValue={topTab === "staff" ? staffCategory : undefined}
          onCategoryChange={(v: string) => {
            const currentCat = topTab === "staff" ? staffCategory : undefined;
            if (v !== currentCat) pushNavHistory(getCurrentNavState());
            if (topTab === "staff") setStaffCategory(v);
          }}
          headerLeft={
            <Box
              as="button"
              aria-label="Go back"
              onClick={canGoBack ? handleBackButton : undefined}
              aria-disabled={!canGoBack}
              px="0"
              py="0"
              flexShrink={0}
              color={canGoBack ? "blue.fg" : "gray.400"}
              opacity={canGoBack ? 1 : 0.6}
              cursor={canGoBack ? "pointer" : "default"}
              _hover={canGoBack ? { color: "blue.fg" } : {}}
              transition="all 0.1s"
              style={{ pointerEvents: canGoBack ? "auto" : "none" }}
            >
              <ArrowLeftCircle size={18} />
            </Box>
          }
          headerRight={
            <HStack gap={2} align="center">
              {/* THE BOARD, gated on the capability its own endpoint asks
                  for. `GET /board` is `schedule.view`; this read
                  `hasAnyRole`, which only means "holds at least one
                  capability of any kind" — so a payroll clerk, who holds
                  four and none of them `schedule.view`, was offered the
                  trophy and got "Couldn't load the board just now." from a
                  403. The board counts visits; somebody who cannot see the
                  schedule has nothing to be shown.

                  `schedule.view` also covers what `hasAnyRole` was there
                  for — a ClientContact and a no-grants account both hold
                  nothing, so neither passes. `topTab !== "client"` stays:
                  this title bar is shared with the customer shell, and the
                  point of client view-as is to mirror what the client
                  sees. */}
              {SHOW_DAY_BOARD_BUTTON && scopeCan("schedule.view") && topTab !== "client" && (
                <DayBoardButton userId={me?.id ?? null} />
              )}
              {/* TRIAL (worker Jobs only): the "How Jobs work" explainer's
                  trigger, moved out of the content portfolio. Inline, that
                  disclosure held a full row at the top of every visit even
                  when collapsed; here it costs nothing until opened. Scoped
                  to one tab deliberately — if it reads well it can replace
                  the inline header everywhere. */}
              <Box
                as="button"
                aria-label="Copy link to this tab"
                title="Copy link to this tab"
                pl="1"
                pr="1"
                py={1}
                display="inline-flex"
                alignItems="center"
                color="gray.fg"
                cursor="pointer"
                _hover={{ color: "blue.fg" }}
                transition="color 0.1s"
                onClick={() => {
                // Build the deep-link URL for the current tab using the same
                // slug convention the resolver consumes: <outer>-<category>-<inner>
                // (with a 2-part fallback for outers that don't have categories).
                const slugify = (s: string) =>
                  (s || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
                const outer = topTab;
                const inner = outer === "client" ? clientInnerTab : staffInnerTab;
                const category = outer === "client" ? undefined : staffCategory;
                const slug = category
                  ? `${outer}-${slugify(category)}-${slugify(inner)}`
                  : `${outer}-${slugify(inner)}`;
                const url = new URL(window.location.origin);
                url.searchParams.set("tab", slug);
                navigator.clipboard.writeText(url.toString()).then(
                  () => publishInlineMessage({ type: "SUCCESS", text: "Link to this tab copied." }),
                  () => publishInlineMessage({ type: "ERROR", text: `Copy failed. Link: ${url.toString()}` }),
                );
              }}
            >
                <Link2 size={16} />
              </Box>
              {/* Whatever explainer the current tab mounted, pushed to the
                  screen edge — a page-level affordance, not part of the tab
                  path. Unconditional: the button renders nothing on tabs that
                  have no explainer, and there is deliberately no per-tab
                  mapping here to fall out of date when a tab is added.
                  No Spacer: this cluster is pinned to the right edge by
                  BreadcrumbNav, so there is no slack for one to take. */}
              <ActiveTabExplainerButton />
            </HStack>
          }
        />
        </>
      )}

      {/* Offline Queue Dialog */}
      {/* WORKFLOWS MOUNT AT THE ROOT, NOT INSIDE A TAB.
          These lived in one tab's `headerSlot`, and BreadcrumbNav renders
          only `activeOuter?.headerSlot` — the ACTIVE top tab's. So clicking
          "New Job Service" from anywhere else set activeWorkflow and nothing
          rendered, because the component that renders it was not mounted:
          the action was silently dead unless you happened to be standing on
          that one tab, with no error to find. A modal workflow has no
          business depending on which tab someone is standing on.

          Mounting them unconditionally is inert — each renders nothing until
          its own `active` prop is true. */}
      <NewJobSetupWorkflow
        scope={scopeBase}
        active={activeWorkflow === "new-job-setup"}
        onDone={() => { setActiveWorkflow(null); setWorkflowEstimateDefaults(null); }}
        estimateDefaults={workflowEstimateDefaults}
        onComplete={(jobId) => {
          if (jobId) {
            // Navigate to Admin Services tab and highlight the new job
            setTopTab("staff");
            setStaffInnerTab("services" as any);
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("open:jobsTabToServicesTabSearch", { detail: { q: jobId, entityId: jobId } }));
            }, 200);
          } else {
            window.location.reload();
          }
        }}
      />
      <SharePhotosWorkflow
        active={activeWorkflow === "share-photos"}
        onDone={() => setActiveWorkflow(null)}
      />

      <OfflineQueueDialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen} />

      {/* Global compliance-policy gate interceptor. Listens for
          `policies:required` events dispatched by lib/api.ts whenever the
          server throws POLICIES_REQUIRED, fetches the fresh required-
          policies list, and opens the sign wizard. Self-hides when no
          worker is signed in or there's nothing to sign. */}
      <PolicyGateInterceptor />
      {/* Post-clock-in / post-clock-out driving-log nudge. Root-mounted for
          the same reason as the policy gate: the workday can be started or
          ended from several surfaces and this one listener covers them all. */}
      <MileageReminderInterceptor />

      {/* Network Info Dialog */}
      <Dialog.Root open={networkInfoOpen} onOpenChange={(e) => setNetworkInfoOpen(e.open)}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>
                  <HStack gap={2}>
                    <Box
                      w="12px"
                      h="12px"
                      borderRadius="full"
                      bg={isOffline ? (isForceOffline ? "orange.strong" : "red.strong") : queueCount > 0 ? "yellow.strong" : "green.strong"}
                    />
                    <Text>{isOffline ? (isForceOffline ? "Force Offline Mode" : "No Connection") : queueCount > 0 ? "Syncing..." : "Online"}</Text>
                  </HStack>
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>How offline mode works</Text>
                    <Text fontSize="xs" color="fg.muted">
                      When you have no internet (or force offline mode is on), the app serves data from its local cache. You can still: pin/unpin, like/unlike, set reminders, post comments, start jobs, complete jobs, dismiss reminders, and upload photos — these will sync when you reconnect. Other actions like accepting payments or editing records require an internet connection.
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Connection status</Text>
                    <VStack align="start" gap={1} fontSize="xs">
                      <HStack gap={2} align="start">
                        <Box w="8px" h="8px" minW="8px" minH="8px" borderRadius="full" bg="green.400" flexShrink={0} mt="4px" />
                        <Text color="fg.muted"><strong>Green</strong> — Online. Everything works normally.</Text>
                      </HStack>
                      <HStack gap={2} align="start">
                        <Box w="8px" h="8px" minW="8px" minH="8px" borderRadius="full" bg="yellow.400" flexShrink={0} mt="4px" />
                        <Text color="fg.muted"><strong>Yellow</strong> — Syncing queued actions. The app is sending offline actions to the server.</Text>
                      </HStack>
                      <HStack gap={2} align="start">
                        <Box w="8px" h="8px" minW="8px" minH="8px" borderRadius="full" bg="orange.400" flexShrink={0} mt="4px" />
                        <Text color="fg.muted"><strong>Orange</strong> — Force offline mode. You chose to go offline. Toggle it off in your Profile to reconnect.</Text>
                      </HStack>
                      <HStack gap={2} align="start">
                        <Box w="8px" h="8px" minW="8px" minH="8px" borderRadius="full" bg="red.400" flexShrink={0} mt="4px" />
                        <Text color="fg.muted"><strong>Red</strong> — No internet connection. The app will automatically reconnect when signal returns.</Text>
                      </HStack>
                    </VStack>
                  </Box>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Cached data</Text>
                    <Text fontSize="xs" color="fg.muted">
                      The app automatically caches data as you browse. Your most recently viewed jobs, properties, and schedules are available offline. For the best offline experience, browse your upcoming jobs while you have signal — that data will then be available in the field.
                    </Text>
                  </Box>
                  {isForceOffline && (
                    <Button
                      size="sm"
                      colorPalette="green"
                      onClick={() => {
                        setForceOffline(false);
                        setNetworkInfoOpen(false);
                      }}
                    >
                      Go back online
                    </Button>
                  )}
                  {!isOffline && (
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="orange"
                      onClick={() => {
                        setForceOffline(true);
                        setNetworkInfoOpen(false);
                      }}
                    >
                      Force offline mode
                    </Button>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button size="sm" variant="ghost" onClick={() => setNetworkInfoOpen(false)}>Close</Button>
              </Dialog.Footer>
              <Dialog.CloseTrigger />
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        confirmColorPalette={confirmAction?.colorPalette ?? "blue"}
        onConfirm={() => {
          confirmAction?.onConfirm();
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </Container>
    </>
  );
}
