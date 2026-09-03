"use client";
import { useEffect, useState, useCallback, useRef, ReactNode } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, Container, Dialog, HStack, Portal, Spinner, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle, ArrowLeftCircle, Banknote, Link2, LineChart } from "lucide-react";
import OnClockBubble from "@/src/ui/components/OnClockBubble";
import { useOffline } from "@/src/lib/offline";
import OfflineQueueDialog from "@/src/ui/dialogs/OfflineQueueDialog";
import PolicyGateInterceptor from "@/src/ui/components/PolicyGateInterceptor";
import { apiGet } from "@/src/lib/api";
import { setCompressionDefaults } from "@/src/lib/imageRedact";
import { bizDateKey, bizToday, bizTomorrow, bizYesterday, bizAddDays, bizHour } from "@/src/lib/dates";
import { isOccurrenceOverdue, loadPaymentRequestExpiryHours } from "@/src/lib/overdueRule";
import { computeDatesFromPreset } from "@/src/lib/datePresets";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import Link from "next/link";
import { UserButton, useAuth, useUser } from "@clerk/clerk-react";

import UsersTab from "@/src/ui/tabs/UsersTab";
import AdminComplianceTab from "@/src/ui/tabs/AdminComplianceTab";
import ActivityTab from "@/src/ui/tabs/ActivityTab";
import HistoryTab from "@/src/ui/tabs/HistoryTab";
import SettingsTab from "@/src/ui/tabs/SettingsTab";
import SuperUnclaimedTab from "@/src/ui/tabs/SuperUnclaimedTab";
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
// ServicesTab: one mount serves both Admin and Super. The tab
// derives Super-only affordances from the caller's actual role via
// determineRoles(me, "ADMIN"), so purpose="ADMIN" is correct for both.
import ClientsTab from "@/src/ui/tabs/ClientsTab";
import PropertiesTab from "@/src/ui/tabs/PropertiesTab";
import PaymentsTab from "@/src/ui/tabs/PaymentsTab";
import ServicesTab from "@/src/ui/tabs/ServicesTab";
import ClientFeedTab from "@/src/ui/tabs/ClientFeedTab";
import ClientMyJobsTab from "@/src/ui/tabs/ClientMyJobsTab";
import ClientServicesTab from "@/src/ui/tabs/ClientServicesTab";
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
import AdminTasksTab, { type TaskDef, FiPlus, FiDownload, FiDatabase, FiShare2 } from "@/src/ui/tabs/AdminTasksTab";
import SharePhotosWorkflow from "@/src/ui/workflows/SharePhotosWorkflow";
// StatisticsTab is no longer wired into the worker or super shell (both tab
// entries were removed per operator preference). The component file and the
// /api/me/statistics + /api/admin/statistics endpoints stay in place so
// the import can be reinstated cleanly if the tab returns.
// import StatisticsTab from "@/src/ui/tabs/StatisticsTab";
import ProfileTab from "@/src/ui/tabs/ProfileTab";
import PreviewRoutesTab from "@/src/ui/tabs/PreviewRoutesTab";
import HomeTab from "@/src/ui/tabs/HomeTab";
import ImpersonationBanner from "@/src/ui/components/ImpersonationBanner";
import MulchJobTool from "@/src/ui/tools/MulchJobTool";
import MowingJobTool from "@/src/ui/tools/MowingJobTool";
import AdminNotifyTab from "@/src/ui/tabs/AdminNotifyTab";
import CollectionsTab from "@/src/ui/tabs/CollectionsTab";
import AdminGroupsTab from "@/src/ui/tabs/AdminGroupsTab";
import PricingTab from "@/src/ui/tabs/PricingTab";
import PromotionsTab from "@/src/ui/tabs/PromotionsTab";
import VanityUrlsTab from "@/src/ui/tabs/VanityUrlsTab";

import AppSplash from "@/src/ui/helpers/AppSplash";
import AwaitingApprovalNotice from "@/src/ui/notices/AwaitingApprovalNotice";
import NoRoleNotice from "@/src/ui/notices/NoRoleNotice";

import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import NewJobSetupWorkflow from "@/src/ui/components/NewJobSetupWorkflow";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

import { Me, Role, AdminTabs, ClientTabs, WorkerTabs, SuperTabs, EventTypes } from "@/src/lib/types";
import { FiActivity, FiAlertCircle, FiBarChart2, FiBell, FiBook, FiBookOpen, FiBriefcase, FiCalendar, FiClipboard, FiClock, FiFileText, FiFolder, FiHome, FiLink, FiMapPin, FiNavigation, FiPackage, FiRefreshCw, FiSearch, FiSettings, FiShield, FiSpeaker, FiSun, FiTag, FiTool, FiTruck, FiUser, FiUserCheck, FiUsers } from "react-icons/fi";
import { GrUserAdmin } from "react-icons/gr";
import { AiOutlineTeam } from "react-icons/ai";
import { TfiMoney } from "react-icons/tfi";

import ScrollableUnderlineTabs, {
  TabItem,
} from "../src/ui/components/ScrollableUnderlineTabs";
import BreadcrumbNav from "@/src/ui/components/BreadcrumbNav";
import RoleChip, { type RoleValue } from "@/src/ui/components/RoleChip";
import TasksPage from "@/src/ui/pages/TasksPage";

const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

/** Where the user was standing when they opened a workflow. Read by
 *  "Return to Workflow" so stepping out to Equipment/Routes and coming
 *  back lands on the launching tab. */
const WORKFLOW_ORIGIN_KEY = "seedlings_workflow_origin";

export default function HomePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  // Clerk user (image, initials) — drives the title-bar avatar that
  // replaces the Clerk UserButton for staff. Clients still see UserButton.
  const { user: clerkUser } = useUser();
  const { isOffline, isForceOffline, setForceOffline, queueCount } = useOffline();
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);

  const [me, setMe] = useState<Me | null>(null);
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
  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isWorker = hasRole(me?.roles, "WORKER");
  const isSuper = hasRole(me?.roles, "SUPER");
  const hasAnyRole = (me?.roles?.length ?? 0) > 0;

  const [topTab, setTopTab] = usePersistedState<"client" | "worker" | "admin" | "super">("topTab", "client");

  // Effective role scope — reflects what the operator is currently
  // acting AS, not just what their underlying account is allowed to
  // do. A Super who has switched their top-tab to "Worker" is looking
  // at the world through a Worker's lens; the alerts dropdown and
  // TasksPage must show only what a Worker would see, otherwise
  // admin/super items (Timeline urgent, Payments to review, etc.) leak
  // through and mislead the operator about what they can act on from
  // the current tab.
  //
  //   scopeIsWorker: active on worker/admin/super tab, requires WORKER role
  //   scopeIsAdmin:  active on admin/super tab,        requires ADMIN role
  //   scopeIsSuper:  active on super tab only,         requires SUPER role
  //
  // Roles nest upward: a Super acting on the Admin tab sees Admin-scope
  // alerts (they can act on them); a Super acting on the Worker tab
  // sees Worker-scope only.
  const scopeIsWorker = (topTab === "worker" || topTab === "admin" || topTab === "super") && isWorker;
  const scopeIsAdmin  = (topTab === "admin" || topTab === "super") && isAdmin;
  const scopeIsSuper  = topTab === "super" && isSuper;

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
  const [adminInnerTab, setAdminInnerTab] = usePersistedState<AdminTabs>("adminTab", "jobs");
  const [workerInnerTab, setWorkerInnerTab] = usePersistedState<WorkerTabs>("workerTab", "home");
  const [workerCategory, setWorkerCategory] = usePersistedState<string>("workerCategory", "Work");
  const [adminCategory, setAdminCategory] = usePersistedState<string>("adminCategory", "Work");
  const [superCategory, setSuperCategory] = usePersistedState<string>("superCategory", "Work");
  const [superInnerTab, setSuperInnerTab] = usePersistedState<SuperTabs>("superTab", "home");
  // Migration: existing users have "operations" or "unclaimed" persisted
  // under superTab from when those tabs existed / were the default.
  // Redirect them to the new "home" tab once, silently — otherwise the
  // Super shell tries to render a non-existent inner tab and shows nothing.
  useEffect(() => {
    // One-shot migration: only inspect the persisted value at mount.
    // Deliberately not keyed on `superInnerTab` so a user navigating
    // to Super → Home doesn't re-run this on every tab change. Empty
    // deps are intentional here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const stale = superInnerTab as string;
    if (stale === "operations" || stale === "unclaimed") setSuperInnerTab("home");
  }, []);

  // Migration: existing workers and admins had removed tab values
  // ("reminders" from the retired Planning tab, "usage" from the
  // retired Equipment Usage tab) persisted under workerTab /
  // adminTab. Redirect them to "home" once so they don't land on a
  // now-nonexistent inner tab and see a blank tab area.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const w = workerInnerTab as string;
    if (w === "reminders" || w === "usage") setWorkerInnerTab("home");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const a = adminInnerTab as string;
    if (a === "reminders" || a === "usage") setAdminInnerTab("home");
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
  // Super-only: count of open ledger followups (Money → Ledger flags
  // waiting on the operator). Drives the "Ledger followups" entry in the
  // alerts dropdown and pre-applies the "Followups only" filter on click.
  const [ledgerFollowupCount, setLedgerFollowupCount] = useState<number>(0);
  // Super-only: count of recurring business expenses whose next expected
  // instance is due within a week (or overdue). Drives the "Due to record"
  // alert in the dropdown + Tasks page shortcut. Source of truth is the
  // Money → Ledger tab's Due-to-Record panel.
  const [dueToRecordCount, setDueToRecordCount] = useState<number>(0);

  // Admin: count of stream-paused occurrences whose reminder date has
  // arrived or passed. Drives the "Paused streams to review" alert +
  // Tasks page shortcut. Source of truth is the Services tab where
  // stream-pauses live.
  const [streamPauseRemindersCount, setStreamPauseRemindersCount] = useState<number>(0);
  // Next-visit ghost placeholders needing attention. Two buckets: due within
  // three days (still fixable) and already past due inside the one-week
  // grace. Deliberately range-independent — see countGhostExpiry.
  const [ghostExpiringCount, setGhostExpiringCount] = useState<number>(0);
  const [ghostExpiredCount, setGhostExpiredCount] = useState<number>(0);

  // Super-only: compliance-policy alerts. Two independent buckets:
  //   pendingUploadReviews = worker uploads awaiting admin approve/reject
  //   pendingApprovals     = policy versions awaiting a second-super approve
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
      setTopTab("worker");
      setWorkerInnerTab("equipment");
      setWorkerCategory("Equipment");
    }
  }, []);

  // Per-tab remount counters. Bumping a key forces React to unmount + remount the
  // corresponding tab, which makes its `usePersistedState` reads pick up freshly-written
  // localStorage values on first render (no flicker).
  const [jobsRemountKey, setJobsRemountKey] = useState(0);
  const [equipmentRemountKey, setEquipmentRemountKey] = useState(0);
  const [paymentsRemountKey, setPaymentsRemountKey] = useState(0);
  // Admin-side remount counters — used by HomeTab (which impersonates a worker)
  // when its tile click-throughs route into admin tabs that need to re-read fresh
  // localStorage filters.
  const [adminJobsRemountKey, setAdminJobsRemountKey] = useState(0);
  const [adminEquipmentRemountKey, setAdminEquipmentRemountKey] = useState(0);
  const [adminPaymentsRemountKey, setAdminPaymentsRemountKey] = useState(0);

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
        setTopTab("worker");
        setWorkerInnerTab("home");
        setWorkerCategory("Work");
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
  type NavState = { outer: string; inner: string; category?: string };
  const navHistoryRef = useRef<NavState[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);

  // Use refs for current nav state so closures always read the latest values
  const topTabRef = useRef(topTab);
  const clientInnerTabRef = useRef(clientInnerTab);
  const workerInnerTabRef = useRef(workerInnerTab);
  const adminInnerTabRef = useRef(adminInnerTab);
  const superInnerTabRef = useRef(superInnerTab);
  const workerCategoryRef = useRef(workerCategory);
  const adminCategoryRef = useRef(adminCategory);
  const superCategoryRef = useRef(superCategory);
  topTabRef.current = topTab;
  clientInnerTabRef.current = clientInnerTab;
  workerInnerTabRef.current = workerInnerTab;
  adminInnerTabRef.current = adminInnerTab;
  superInnerTabRef.current = superInnerTab;
  workerCategoryRef.current = workerCategory;
  adminCategoryRef.current = adminCategory;
  superCategoryRef.current = superCategory;

  function getCurrentNavState(): NavState {
    const t = topTabRef.current;
    const inner = t === "client" ? clientInnerTabRef.current
      : t === "worker" ? workerInnerTabRef.current
      : t === "admin" ? adminInnerTabRef.current
      : superInnerTabRef.current;
    const category = t === "worker" ? workerCategoryRef.current : t === "admin" ? adminCategoryRef.current : t === "super" ? superCategoryRef.current : undefined;
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
    else if (prev.outer === "worker") { workerInnerTabRef.current = prev.inner as any; if (prev.category) workerCategoryRef.current = prev.category; }
    else if (prev.outer === "admin") { adminInnerTabRef.current = prev.inner as any; if (prev.category) adminCategoryRef.current = prev.category; }
    else if (prev.outer === "super") { superInnerTabRef.current = prev.inner as any; if (prev.category) superCategoryRef.current = prev.category; }
    // Now set React state (no skipNextPush needed — onOuterChange/onInnerChange only fire from user clicks)
    setTopTab(prev.outer as any);
    if (prev.outer === "client") setClientInnerTab(prev.inner as any);
    else if (prev.outer === "worker") { setWorkerInnerTab(prev.inner as any); if (prev.category) setWorkerCategory(prev.category); }
    else if (prev.outer === "admin") { setAdminInnerTab(prev.inner as any); if (prev.category) setAdminCategory(prev.category); }
    else if (prev.outer === "super") { setSuperInnerTab(prev.inner as any); if (prev.category) setSuperCategory(prev.category); }
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
    window.addEventListener("navigate:workerTab", onCheck);
    return () => { window.removeEventListener("storage", check); window.removeEventListener("navigate:workerTab", onCheck); };
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
      const { text } = await apiGet<{ text: string }>("/api/admin/export-summary");
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
      const data = await apiGet<Record<string, unknown>>("/api/admin/export");
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



  const adminTasks: TaskDef[] = [
    {
      id: "new-job-setup",
      label: "New Job Service",
      description: "Create a new client, property, job, and first occurrence",
      icon: FiPlus,
      colorPalette: "green",
      bgColor: "green.50",
      onClick: () => launchWorkflow("new-job-setup"),
    },
    {
      id: "share-photos",
      label: "Share Photos",
      description: "Select photos from jobs and share to Instagram, social media, or download",
      icon: FiShare2,
      colorPalette: "orange",
      bgColor: "orange.50",
      onClick: () => launchWorkflow("share-photos"),
    },
    {
      id: "export-summary",
      label: "Export Summary",
      description: "Download a human-readable summary of all your data",
      icon: FiDownload,
      colorPalette: "blue",
      bgColor: "blue.50",
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
      bgColor: "purple.50",
      disabled: !isSuper,
      disabledMessage: "Only super administrators can export all data.",
      onClick: () => {
        if (!isSuper) {
          setConfirmAction({ title: "Restricted", message: "Only super administrators can export all data.", confirmLabel: "OK", colorPalette: "purple", onConfirm: () => {} });
        } else {
          setConfirmAction({
            title: "Export Raw Data",
            message: "This will download all raw data as JSON. This may be a large file. Continue?",
            confirmLabel: "Download",
            colorPalette: "purple",
            onConfirm: downloadRaw,
          });
        }
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
  const refreshMe = useCallback(async () => {
    try {
      const data = await apiGet<Me>("/api/me");
      setMe(data);
    } catch {}
  }, []);

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
  // Staff-only: /api/settings is worker/admin/super-gated and 403s for
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
    // Don't reset tabs until we know the user's roles
    if (!me) return;
    if (topTab === "admin" && !isAdmin)
      setTopTab(isWorker ? "worker" : "client");
    if (topTab === "worker" && !isWorker)
      setTopTab(isAdmin ? "admin" : "client");
    if (topTab === "super" && !isSuper)
      setTopTab(isAdmin ? "admin" : isWorker ? "worker" : "client");
  }, [isAdmin, isWorker, topTab, me]);

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
    if (isWorker || isAdmin) return;
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
  }, [me?.isApproved, isWorker, isAdmin, topTab, clientInnerTab, setClientInnerTab]);

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
      visible: () => !!isSignedIn && !!me?.isApproved && !isWorker && !isAdmin,
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
      visible: () => !!isSignedIn && !!me?.isApproved && !isWorker && !isAdmin,
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
      // on `ClientTabs` in types.ts. Same value as the Admin Work
      // Services tab would cause BreadcrumbNav to render a
      // cross-role chip pairing the two, which is wrong: they're
      // unrelated tabs (client's subscribed services vs. operator's
      // job-recipe manager).
      value: "client-services",
      label: "Services",
      icon: FiClipboard,
      content: <ClientServicesTab />,
    },
  ];

  const isTraineeWorker = me?.workerType === "TRAINEE";

  const workerTasks: TaskDef[] = [
    {
      id: "plan-route",
      label: "Plan Next Work Day",
      description: isTraineeWorker ? "View your upcoming job summary" : "Confirm your claimed jobs for tomorrow and notify clients",
      icon: FiNavigation,
      colorPalette: "blue",
      bgColor: "blue.50",
      onClick: () => {
        if (isTraineeWorker) {
          setConfirmAction({
            title: "Trainee — Read Only",
            message: "As a trainee, you can view your upcoming job summary but cannot confirm, release, or message clients. Contact your team lead to manage your schedule.",
            confirmLabel: "View Summary",
            colorPalette: "blue",
            onConfirm: () => launchWorkflow("plan-workday-trainee", { targetDate: bizTomorrow() }),
          });
        } else {
          launchWorkflow("plan-workday", { targetDate: bizTomorrow() });
        }
      },
    },
    {
      id: "start-day",
      label: "Prepare for Work Day",
      description: "Review today's schedule, confirm jobs, and start your first stop",
      icon: FiSun,
      colorPalette: "green",
      bgColor: "green.50",
      onClick: () => {
        launchWorkflow("begin-workday");
      },
    },
  ];

  // Order matters: BreadcrumbNav derives the category list (and the inner-tab
  // list within each category) from the order tabs appear here. Keep tabs of
  // the same category contiguous, categories in the intended display order:
  // Work · Equipment · Directory · Money · Records · System.
  const workerTabs: TabItem[] = [
    // ── Work ──
    {
      value: "home",
      label: "Home",
      icon: FiHome,
      content: wrapWithInlineMessage(
        <HomeTab
          me={me}
          onLaunchWorkflow={(name, opts) => launchWorkflow(name, opts)}
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    {
      value: "jobs",
      label: "Jobs",
      icon: FiClipboard,
      content: wrapWithInlineMessage(
        <JobsTab
          key={`wjobs-${jobsRemountKey}`}
          me={me}
          purpose="WORKER"
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    {
      value: "routes",
      label: "Routes",
      icon: FiNavigation,
      visible: () => !!me?.workerType,
      content: wrapWithInlineMessage(
        <PreviewRoutesTab scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />
      ),
    },
    {
      value: "tasks",
      label: "Actions",
      icon: FiPlus,
      content: <AdminTasksTab tasks={workerTasks} />,
    },
    // ── Equipment ──
    {
      value: "equipment",
      label: "Inventory",
      icon: FiTool,
      content: wrapWithInlineMessage(
        <InventoryTab
          key={`weq-${equipmentRemountKey}`}
          me={me}
          purpose="WORKER"
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    {
      value: "collections",
      label: "Collections",
      icon: FiPackage,
      content: wrapWithInlineMessage(
        <CollectionsTab
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    {
      value: "vehicles",
      label: "Vehicles",
      icon: FiTruck,
      content: wrapWithInlineMessage(
        <VehiclesTab
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    // ── Directory ──
    {
      value: "clients",
      label: "Clients",
      icon: FiUsers,
      content: wrapWithInlineMessage(
        <ClientsTab
          me={me}
          purpose="WORKER"
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    {
      value: "properties",
      label: "Properties",
      icon: FiMapPin,
      content: wrapWithInlineMessage(
        <PropertiesTab
          me={me}
          purpose="WORKER"
          scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
        />
      ),
    },
    {
      // Team roster — read-only list of active workers (name +
      // worker-type badge only). Sensitive data (email, wage, roles,
      // privilege flags) is scrubbed server-side and again on the
      // client. Admin/Super get the full user-management UI on their
      // own tabs.
      value: "users",
      label: "Users",
      icon: AiOutlineTeam,
      content: wrapWithInlineMessage(
        <UsersTab scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />
      ),
    },
    {
      // Worker view — read-only list of ONLY the crews the caller is on.
      // Fetches from /api/me/groups; cost-split percentages and other
      // crews the worker isn't on stay hidden.
      value: "groups",
      label: "Groups",
      icon: AiOutlineTeam,
      content: wrapWithInlineMessage(
        <AdminGroupsTab scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />
      ),
    },
    // ── Money ──
    {
      value: "payments",
      label: "Payments",
      icon: TfiMoney,
      content: wrapWithInlineMessage(<PaymentsTab key={`wpay-${paymentsRemountKey}`} me={me} purpose="WORKER" scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />),
    },
    {
      // Worker payroll is view-only and own-rows-only; the server enforces
      // both, not this component. See docs/features/payroll.md.
      value: "payroll",
      label: "Payroll",
      // Banknote, not TfiMoney — the Money CATEGORY and the Payments tab
      // both use the dollar glyph, so repeating it here made three
      // identical icons in one dropdown. Matches the Home PAYROLL section.
      icon: Banknote,
      content: wrapWithInlineMessage(<PayrollTab me={me} purpose="WORKER" scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />),
    },
    {
      value: "pricing",
      label: "Pricing",
      icon: FiTag,
      content: wrapWithInlineMessage(<PricingTab readOnly scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />),
    },
    {
      value: "supplies",
      label: "Supplies",
      icon: FiPackage,
      content: wrapWithInlineMessage(<SuppliesTab readOnly purpose="WORKER" scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />),
    },
    // NOTE: the Worker "Records → Statistics" tab was removed per operator
    // preference (no longer needed). The StatisticsTab component file and
    // its API endpoints (/api/me/statistics, /api/admin/statistics) stay
    // in place in case the tab is wanted back later — to restore, re-add a
    // tab block here with visible: () => !!me?.workerType and
    // content: <StatisticsTab myId={me?.id} />, plus the catMap entry
    // `statistics: "Records"` below.
    {
      // ── Records ──
      // Education guides. Present for EVERY role by design: the whole
      // point is that workers can read the material. Authoring and
      // approval are gated inside the tab by `scope`, not by hiding it.
      // See docs/features/education.md.
      value: "guides",
      label: "Guides",
      icon: FiBookOpen,
      content: wrapWithInlineMessage(
        <GuidesTab me={me} purpose="WORKER" scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }} />,
      ),
    },
    // ── System ──
    {
      value: "profile",
      label: "Profile",
      icon: FiUser,
      content: wrapWithInlineMessage(<ProfileTab me={me} purpose="WORKER" onProfileUpdated={refreshMe} />),
    },
  ];

  const adminTabs: TabItem[] = [
    {
      // ── Work ──
      // Inner value matches the Worker shell's Home tab so BreadcrumbNav's
      // cross-role jump chip pairs them — one tap in the inner dropdown
      // takes Admin → Worker Home and vice versa.
      value: "home",
      label: "Home",
      icon: FiHome,
      content: wrapWithInlineMessage(
        <HomeTab
          me={me}
          onLaunchWorkflow={() => {}}
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "jobs",
      label: "Jobs",
      icon: FiClipboard,
      content: wrapWithInlineMessage(
        <JobsTab
          key={`ajobs-${adminJobsRemountKey}`}
          me={me}
          purpose="ADMIN"
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "routes",
      label: "Routes",
      icon: FiNavigation,
      content: wrapWithInlineMessage(
        <PreviewRoutesTab scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }} />
      ),
    },
    {
      // Was `value: "jobs"`, but Worker's Jobs tab also uses `"jobs"` —
      // that collision made BreadcrumbNav's cross-role chip from
      // Worker → Jobs land here (Services) instead of on Admin → Jobs.
      // Renamed to `"services"` so the chip pairing is unambiguous:
      // Jobs ↔ Jobs (the Admin Jobs tab below uses `value: "jobs"`).
      value: "services",
      label: "Services",
      icon: FiBriefcase,
      content: wrapWithInlineMessage(
        <ServicesTab
          me={me}
          purpose="ADMIN"
          streamReviewOccId={streamReviewOccId}
          streamReviewNonce={streamReviewNonce}
        />,
      ),
    },
    {
      value: "tasks",
      label: "Actions",
      icon: FiPlus,
      content: <AdminTasksTab tasks={adminTasks} />,
    },
    {
      // ── Equipment ──
      value: "equipment",
      label: "Inventory",
      icon: FiTool,
      content: wrapWithInlineMessage(
        <InventoryTab
          key={`aeq-${adminEquipmentRemountKey}`}
          me={me}
          purpose="ADMIN"
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "collections",
      label: "Collections",
      icon: FiPackage,
      content: wrapWithInlineMessage(
        <CollectionsTab
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "vehicles",
      label: "Vehicles",
      icon: FiTruck,
      content: wrapWithInlineMessage(
        <VehiclesTab
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      // ── Directory ──
      value: "clients",
      label: "Clients",
      icon: FiUsers,
      content: wrapWithInlineMessage(
        <ClientsTab
          me={me}
          purpose="ADMIN"
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "properties",
      label: "Properties",
      icon: FiMapPin,
      content: wrapWithInlineMessage(
        <PropertiesTab
          me={me}
          purpose="ADMIN"
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "users",
      label: "Users",
      icon: AiOutlineTeam,
      // Read-only for admins. User management (approve / role changes /
      // privilege toggles / delete) moved to the Super tab. Admins see
      // the directory for context but can't mutate it, and pending
      // users are hidden entirely so the queue doesn't tempt action.
      content: wrapWithInlineMessage(
        <UsersTab
          role="admin"
          readOnly
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />
      ),
    },
    {
      value: "groups",
      label: "Groups",
      icon: AiOutlineTeam,
      content: wrapWithInlineMessage(
        <AdminGroupsTab scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }} />
      ),
    },
    {
      // ── Money ──
      value: "payments",
      label: "Payments",
      icon: TfiMoney,
      content: wrapWithInlineMessage(<PaymentsTab key={`apay-${adminPaymentsRemountKey}`} me={me} purpose="ADMIN" scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }} />),
    },
    {
      // Admin sees the team total, or one worker's hours/gross/net when a
      // worker is selected. The tax breakdown is withheld server-side.
      value: "payroll",
      label: "Payroll",
      icon: Banknote,
      content: wrapWithInlineMessage(<PayrollTab me={me} purpose="ADMIN" scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }} />),
    },
    {
      value: "pricing",
      label: "Pricing",
      icon: FiTag,
      content: wrapWithInlineMessage(<PricingTab readOnly scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }} />),
    },
    {
      value: "supplies",
      label: "Supplies",
      icon: FiPackage,
      content: wrapWithInlineMessage(<SuppliesTab readOnly purpose="ADMIN" scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }} />),
    },
    {
      // ── Records ── (audit / review surfaces — placed between
      // Money and System so the Admin category strip matches the
      // canonical top-level order Work → Equipment → Directory →
      // Money → Records → System.)
      value: "activity",
      label: "Engagement",
      icon: FiActivity,
      content: wrapWithInlineMessage(<ActivityTab role="admin" />),
    },
    {
      value: "history",
      label: "History",
      icon: FiFileText,
      content: wrapWithInlineMessage(<HistoryTab role="admin" />),
    },
    {
      value: "timeline",
      label: "Timeline",
      icon: FiCalendar,
      content: wrapWithInlineMessage(<TimelineTab />),
    },
    {
      value: "documents",
      label: "Documents",
      icon: FiFolder,
      content: wrapWithInlineMessage(<DocumentsTab />),
    },
    {
      // Education guides — see docs/features/education.md. Admin authors
      // drafts and manages their own images; approval and video are Super.
      value: "guides",
      label: "Guides",
      icon: FiBookOpen,
      content: wrapWithInlineMessage(
        <GuidesTab
          me={me}
          purpose="ADMIN"
          scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
        />,
      ),
    },
    {
      // ── System ── (order: Profile → Notify → Settings)
      value: "profile",
      label: "Profile",
      icon: FiUser,
      content: wrapWithInlineMessage(<ProfileTab me={me} isAdmin purpose="ADMIN" onProfileUpdated={refreshMe} />),
    },
    {
      value: "notify",
      label: "Notify",
      icon: FiBell,
      content: wrapWithInlineMessage(<AdminNotifyTab />),
    },
    {
      value: "settings",
      label: "Settings",
      icon: FiSettings,
      content: wrapWithInlineMessage(<SettingsTab me={me} purpose="ADMIN" />),
    },
  ];

  const navTabs: import("@/src/ui/components/BreadcrumbNav").OuterTab[] = [
    {
      value: "client",
      label: "Client",
      icon: FiHome,
      visible: true,
      innerTabs: clientTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content })),
    },
    {
      value: "worker",
      label: "Worker",
      icon: FiUser,
      visible: () => !!isSignedIn && !!me?.isApproved && isWorker,
      headerSlot: (
        <>
          {me && !me.workerType && (
            <Box mb={2} p={3} bg="orange.50" borderWidth="1px" borderColor="orange.300" rounded="md">
              <HStack gap={2} align="start">
                <Box flexShrink={0} pt="0.5"><AlertTriangle size={14} color="var(--chakra-colors-orange-500)" /></Box>
                <Text fontSize="sm" color="orange.700">
                  Your worker type has not been assigned yet. Some features may be restricted until assigned by your administrator.
                </Text>
              </HStack>
            </Box>
          )}
          {me?.workerType === "TRAINEE" && (
            <Box mb={2} p={3} bg="blue.50" borderWidth="1px" borderColor="blue.300" rounded="md">
              <HStack gap={2} align="start">
                <Box flexShrink={0} pt="0.5"><AlertTriangle size={14} color="var(--chakra-colors-blue-500)" /></Box>
                <Text fontSize="sm" color="blue.700">
                  You are currently a Trainee. You can view details and be added to a team, but you cannot claim jobs, take actions, or reserve equipment. You also have limited visibility to jobs, clients, and properties you are assigned to. Contact your team manager to take actions on your behalf.
                </Text>
              </HStack>
            </Box>
          )}
          {/* Contractor-insurance banner removed with the compliance-policy
              migration. Slice 2 adds a general "N compliance items pending"
              banner sourced from GET /me/policies that covers insurance,
              W-9, safety SOP, and every other configured policy. */}
          <PlanWorkdayWorkflow
            active={activeWorkflow === "plan-workday" || activeWorkflow === "plan-workday-trainee"}
            onDone={() => setActiveWorkflow(null)}
            myId={me?.id}
            defaultTargetDate={planWorkdayDate ?? undefined}
            trainee={activeWorkflow === "plan-workday-trainee"}
          />
          <BeginWorkDayWorkflow
            active={activeWorkflow === "begin-workday"}
            onDone={() => setActiveWorkflow(null)}
            myId={me?.id}
            myWorkerType={me?.workerType ?? null}
          />
          {pausedWorkflow && !(
            (workflowOrigin?.outer ?? "worker") === topTab &&
            (workflowOrigin?.inner ?? "tasks") === workerInnerTab
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
                  // Falls back to worker/tasks when no origin was recorded
                  // (older paused state, or a write that failed).
                  applyNavState(workflowOrigin ?? { outer: "worker", inner: "tasks", category: "Work" });
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
      innerTabs: (() => {
        // Mirror the admin layout so a worker promoted to admin doesn't have
        // to relearn the tab map. Categories: Work · Equipment · Directory ·
        // Money · Records · System.
        const catMap: Record<string, string> = {
          home: "Work", jobs: "Work", routes: "Work", tasks: "Work",
          equipment: "Equipment", collections: "Equipment", vehicles: "Equipment",
          clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
          payments: "Money", payroll: "Money", pricing: "Money", supplies: "Money",
          // statistics: "Records" — re-add when the Worker Statistics tab is restored.
          guides: "Records",
          profile: "System",
        };
        const catIconMap: Record<string, React.ElementType> = {
          Work: FiClipboard, Equipment: FiTool, Directory: FiUsers, Money: TfiMoney, Records: FiBarChart2, System: FiSettings,
        };
        return workerTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content, category: catMap[t.value], categoryIcon: catIconMap[catMap[t.value]], // Actions/tasks tab was previously chip-styled on Worker + Admin
// (`chip: t.value === "tasks"`), but Super renders it plain — the
// mismatch read as a bug. Dropping the chip so all three roles
// render the Actions tab with the same plain style.
chip: false, bucket: t.bucket }));
      })(),
    },
    {
      value: "admin",
      label: "Admin",
      icon: GrUserAdmin,
      visible: () => !!isSignedIn && isAdmin,
      headerSlot: (
        <>
          <NewJobSetupWorkflow
            active={activeWorkflow === "new-job-setup"}
            onDone={() => { setActiveWorkflow(null); setWorkflowEstimateDefaults(null); }}
            estimateDefaults={workflowEstimateDefaults}
            onComplete={(jobId) => {
              if (jobId) {
                // Navigate to Admin Services tab and highlight the new job
                setTopTab("admin");
                setAdminInnerTab("services" as any);
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent("open:jobsTabToServicesTabSearch", { detail: { q: jobId, forAdmin: true, entityId: jobId } }));
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
        </>
      ),
      innerTabs: (() => {
        const catMap: Record<string, string> = {
          home: "Work", jobs: "Work", routes: "Work", services: "Work", tasks: "Work",
          equipment: "Equipment", collections: "Equipment", vehicles: "Equipment",
          clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
          payments: "Money", payroll: "Money", pricing: "Money", supplies: "Money",
          activity: "Records", history: "Records", timeline: "Records", documents: "Records", guides: "Records",
          notify: "System", settings: "System", profile: "System",
        };
        const catIconMap: Record<string, React.ElementType> = {
          Work: FiClipboard, Equipment: FiTool, Directory: FiUsers, Money: TfiMoney, Records: FiBarChart2, System: FiSettings,
        };
        return adminTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content, category: catMap[t.value], categoryIcon: catIconMap[catMap[t.value]], // Actions/tasks tab was previously chip-styled on Worker + Admin
// (`chip: t.value === "tasks"`), but Super renders it plain — the
// mismatch read as a bug. Dropping the chip so all three roles
// render the Actions tab with the same plain style.
chip: false, bucket: t.bucket }));
      })(),
    },
    {
      value: "super",
      label: "Super",
      icon: FiShield,
      visible: () => !!isSignedIn && isSuper,
      innerTabs: [
        {
          // ── Work ──
          // Operations-pulse dashboard — money / jobs / equipment /
          // team / clients rollup for a rolling period ending today.
          // One period button drives every section. This is where the
          // Super lands on entering the Super tab; matches the Admin
          // shell's "Home" landing pattern.
          value: "home",
          label: "Home",
          icon: FiHome,
          content: wrapWithInlineMessage(
            <HomeTab
              me={me}
              onLaunchWorkflow={() => {}}
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Jobs — same JobsTab as Admin+Worker, driven by scope so the
          // Super sees admin+super overlays (Client Requests, Ops
          // summary strip, cancel/reopen action row, etc.).
          value: "jobs",
          label: "Jobs",
          icon: FiClipboard,
          content: wrapWithInlineMessage(
            <JobsTab
              me={me}
              purpose="ADMIN"
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Routes — same PreviewRoutesTab as Admin+Worker. Scope
          // brings the Super's team-travel Operations panel to the
          // top of the tab.
          value: "routes",
          label: "Routes",
          icon: FiNavigation,
          content: wrapWithInlineMessage(
            <PreviewRoutesTab scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }} />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Services — the same shipped ServicesTab admins see.
          // Super-only affordances gate on the user's actual role
          // internally, so purpose="ADMIN" is intentional.
          value: "services",
          label: "Services",
          icon: FiBriefcase,
          content: wrapWithInlineMessage(
            <ServicesTab
              me={me}
              purpose="ADMIN"
              streamReviewOccId={streamReviewOccId}
              streamReviewNonce={streamReviewNonce}
            />
          ),
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // Actions (+) — same shipped AdminTasksTab admins see.
          // Super uses the admin task list; there's no super-only
          // shortcut set today, but the tab is here so cross-role
          // navigation stays consistent.
          value: "tasks",
          label: "Actions",
          icon: FiPlus,
          content: <AdminTasksTab tasks={adminTasks} />,
          category: "Work",
          categoryIcon: FiHome,
        },
        {
          // ── Equipment ──
          // Same component as the admin Inventory tab, but rendered with
          // scope.isSuper so InventoryTab exposes its act-on-behalf-of-
          // worker controls (reserve / cancel / checkout / return for a
          // specific worker). Fail-safe for when a worker is stuck in the
          // mobile flow and a Super needs to drive the action remotely.
          //
          // Positioned right after Services so the Equipment category
          // sits IMMEDIATELY BELOW Work in the category strip (matches
          // Worker/Admin tab-order).
          value: "equipment",
          label: "Inventory",
          icon: FiTool,
          content: wrapWithInlineMessage(
            <InventoryTab
              key={`seq-${adminEquipmentRemountKey}`}
              me={me}
              purpose="SUPER"
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Equipment",
          categoryIcon: FiTool,
        },
        {
          // ── Equipment → Collections (Super scope) ──
          // Blended CollectionsTab renders admin CRUD + a Super-only
          // Insights strip (kits with issues, availability, job
          // coverage) computed from the collections payload — no
          // extra server round-trip.
          value: "collections",
          label: "Collections",
          icon: FiPackage,
          content: wrapWithInlineMessage(
            <CollectionsTab
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
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
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Equipment",
          categoryIcon: FiTool,
        },
        {
          // ── Directory ── (Clients → Properties → Users → Groups)
          // Clients — Super's home for the "View as this client"
          // affordance (Super-only impersonation for support debugging).
          // Mounted with purpose="SUPER" so ClientsTab can distinguish
          // this from the admin-side Clients mount and render the "View
          // as" button only here. See ViewAsClientButton gate below.
          value: "clients",
          label: "Clients",
          icon: FiUsers,
          content: wrapWithInlineMessage(
            <ClientsTab
              me={me}
              purpose="SUPER"
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Properties — same PropertiesTab admins see. Mounted at the
          // Super tier for parity with Admin's Directory category. The
          // legacy `purpose="ADMIN"` is preserved for backward-compat;
          // the additive `scope` prop is authoritative and passes the
          // Super capability through so `superRequired` (hard-delete
          // unlock) resolves correctly here.
          value: "properties",
          label: "Properties",
          icon: FiMapPin,
          content: wrapWithInlineMessage(
            <PropertiesTab
              me={me}
              purpose="ADMIN"
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Super-only writable Users view. The same component admins
          // see read-only on their Directory tab, but with full mutation
          // surface (approve / role changes / privilege toggles / delete).
          // The "Pending Users" alert chip in the title bar routes here.
          value: "users",
          label: "Users",
          icon: AiOutlineTeam,
          content: wrapWithInlineMessage(
            <UsersTab
              role="admin"
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
            />
          ),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // Groups — the same AdminGroupsTab admins see. Groups (crews)
          // are managed at the admin tier, but Super also needs the
          // surface for support debugging + cross-role parity.
          value: "groups",
          label: "Groups",
          icon: AiOutlineTeam,
          content: wrapWithInlineMessage(
            <AdminGroupsTab scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }} />
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
          // Payments/Pricing/Supplies are shared across all three roles
          // via the additive scope prop; Payroll is shared but heavily
          // scoped, and Ledger + Forecast + Promotions are Super-only.)
          value: "payments",
          label: "Payments",
          icon: TfiMoney,
          content: wrapWithInlineMessage(<PaymentsTab me={me} purpose="SUPER" scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          // Super: full detail, plus upload / identity matching / archive.
          value: "payroll",
          label: "Payroll",
          icon: Banknote,
          content: wrapWithInlineMessage(<PayrollTab me={me} purpose="SUPER" scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }} />),
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
          // Super-only — Ledger is intentionally NOT mounted for Admin or
          // Worker.
          value: "ledger",
          label: "Ledger",
          icon: FiBook,
          content: wrapWithInlineMessage(<BusinessExpensesTab />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          value: "pricing",
          label: "Pricing",
          icon: FiTag,
          content: wrapWithInlineMessage(<PricingTab isSuper scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        // NOTE: the Super "Money → Statistics" tab was removed per operator
        // preference (no longer needed for routine ops review). The
        // StatisticsTab component still ships for the Worker personal-stats
        // view (workerTabs, "Records" category). To restore the Super entry,
        // re-add a tab block here pointing at <StatisticsTab /> (no myId).
        {
          value: "supplies",
          label: "Supplies",
          icon: FiPackage,
          content: wrapWithInlineMessage(<SuppliesTab scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }} />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          // Promotions — Super-only marketing campaigns. Piggyback on
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
        {
          // Pay-structure simulator. Super-only, and deliberately NOT part of
          // Reconcile or the P&L: those report what happened, this asks what
          // should change. Keeping them separate stops a projection from ever
          // being mistaken for a record.
          value: "forecast",
          label: "Forecast",
          icon: LineChart,
          content: wrapWithInlineMessage(<ForecastTab />),
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
          content: wrapWithInlineMessage(<ReconcileTab />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Workdays — Super-only review queue for per-worker clock-in/out.
          // Day-paged; the 4 AM ET cutoff (settings-driven) gates approval
          // actions on each row. See ui/tabs/WorkdaysTab.tsx +
          // services/workdays.ts (superListWorkdaysForDate et al).
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
          content: wrapWithInlineMessage(<AdminComplianceTab />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Engagement — same ActivityTab admins see. Surfaced under
          // Super Records for parity with Admin's Records sub-tabs.
          value: "activity",
          label: "Engagement",
          icon: FiActivity,
          content: wrapWithInlineMessage(<ActivityTab role="admin" />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // History — same HistoryTab admins see. Same rationale as
          // Engagement above.
          value: "history",
          label: "History",
          icon: FiFileText,
          content: wrapWithInlineMessage(<HistoryTab role="admin" />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          value: "timeline",
          label: "Timeline",
          icon: FiCalendar,
          content: wrapWithInlineMessage(<TimelineTab isSuper />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          value: "documents",
          label: "Documents",
          icon: FiFolder,
          content: wrapWithInlineMessage(<DocumentsTab isSuper />),
          category: "Records",
          categoryIcon: FiBarChart2,
        },
        {
          // Education guides — see docs/features/education.md. Super is the
          // only role that approves content or touches video.
          value: "guides",
          label: "Guides",
          icon: FiBookOpen,
          content: wrapWithInlineMessage(
            <GuidesTab
              me={me}
              purpose="SUPER"
              scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
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
          content: wrapWithInlineMessage(<ProfileTab me={me} isAdmin purpose="SUPER" onProfileUpdated={refreshMe} />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          // Notify — same AdminNotifyTab admins use. Mounted here for
          // parity with the Admin System sub-tab list.
          value: "notify",
          label: "Notify",
          icon: FiBell,
          content: wrapWithInlineMessage(<AdminNotifyTab />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          // Vanity — Super-only editor for branded shortcuts on
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
          value: "settings",
          label: "Settings",
          icon: FiSettings,
          content: wrapWithInlineMessage(<SettingsTab me={me} purpose="SUPER" />),
          category: "System",
          categoryIcon: FiSettings,
        },
      ],
    },
  ];

  // Header-mounted role switcher — replaces the outer role pill that used
  // to lead the BreadcrumbNav. Roles are computed from navTabs' visibility
  // functions so a single source of truth (the tab-tree) drives BOTH the
  // rendered chrome and the switcher options. Client is always present
  // (visible: true above); the others gate on isWorker/isAdmin/isSuper.
  const availableRoles = navTabs
    .filter((t) => (typeof t.visible === "function" ? t.visible() : t.visible !== false))
    .map((t) => ({ value: t.value as RoleValue, label: t.label, icon: t.icon }));

  // Switch role while preserving the current inner tab when the same tab
  // value exists in the target role. When it doesn't, we leave the target
  // role's persisted inner tab alone — that's normally the role's own
  // last-viewed tab or its default landing. Also pushes nav history so the
  // back button retraces the role switch.
  function switchRole(newRole: RoleValue) {
    if (newRole === topTab) return;
    const currentInner =
      topTab === "client" ? clientInnerTab
      : topTab === "worker" ? workerInnerTab
      : topTab === "admin" ? adminInnerTab
      : superInnerTab;
    const targetRoleTabs = navTabs.find((n) => n.value === newRole)?.innerTabs ?? [];
    const equivalent = targetRoleTabs.find(
      (t) => t.value === currentInner
        && (typeof t.visible === "function" ? t.visible() : t.visible !== false),
    );
    pushNavHistory(getCurrentNavState());
    if (equivalent) {
      if (newRole === "client") setClientInnerTab(equivalent.value as ClientTabs);
      else if (newRole === "worker") setWorkerInnerTab(equivalent.value as WorkerTabs);
      else if (newRole === "admin") setAdminInnerTab(equivalent.value as AdminTabs);
      else if (newRole === "super") setSuperInnerTab(equivalent.value as SuperTabs);
    }
    setTopTab(newRole);
  }

  // `tabName` can be:
  //   • a string  — same target tab for admin and worker (must exist
  //                  in BOTH AdminTabs & WorkerTabs)
  //   • an object — separate targets, with `worker: null` marking
  //                  "no worker-scope destination" (dispatchers must
  //                  pass forAdmin:true; a worker dispatcher no-ops
  //                  with a console warn). Use this for admin-only
  //                  destinations like Services.
  const setupSearchEvent = (
    eventName: EventTypes,
    tabName: (AdminTabs & WorkerTabs) | { admin: AdminTabs; worker: WorkerTabs | null }
  ) => {
    const adminTarget: AdminTabs = typeof tabName === "string" ? tabName : tabName.admin;
    const workerTarget: WorkerTabs | null = typeof tabName === "string" ? tabName : tabName.worker;
    useEffect(() => {
      if (typeof window === "undefined") return;
      const onEvent = (e: Event) => {
        const { q, forAdmin, entityId } = (e as CustomEvent).detail || {};
        if (!q && !entityId) return;
        if (!forAdmin && workerTarget === null) {
          // Admin-only destination — a worker-scope dispatcher would
          // land nowhere useful. No-op rather than silently misroute.
          if (typeof console !== "undefined") {
            console.warn(`[${eventName}] worker-scope dispatch ignored; this event is admin-only`);
          }
          return;
        }
        pushNavHistory(getCurrentNavState());
        setTopTab(forAdmin ? "admin" : "worker");
        forAdmin ? setAdminInnerTab(adminTarget) : setWorkerInnerTab(workerTarget as WorkerTabs);
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
    }, [topTab, adminInnerTab, workerInnerTab]);
  };

  setupSearchEvent("clientTabToPropertiesTabSearch", "properties");
  setupSearchEvent("propertyTabToClientTabSearch", "clients");
  setupSearchEvent("propertyTabToClientTabContactSearch", "clients");
  setupSearchEvent("activityTavToEquipmentTabQRCodeSearch", "equipment");
  setupSearchEvent("jobsToEquipmentKindFilter", "equipment");
  setupSearchEvent("jobsTabToPropertiesTabSearch", "properties");
  setupSearchEvent("jobsTabToClientsTabSearch", "clients");
  setupSearchEvent("paymentsTabToPropertiesTabSearch", "properties");
  setupSearchEvent("paymentsTabToClientsTabSearch", "clients");
  // jobsTabToServicesTabSearch — "Manage in Services" button on the
  // JobsTab occurrence card. The `:run` handler lives in ServicesTab
  // (see ServicesTab.tsx), so we must route to the "services" tab so
  // that handler is actually mounted when the event fires. A previous
  // change routed this to "jobs" which silently broke the button.
  setupSearchEvent("jobsTabToServicesTabSearch", { admin: "services", worker: null });
  // clientsTabToServicesTabSearch — "N services paused" click on the
  // ClientsTab card. Routes to Services; ServicesTab's :run listener
  // sets q to the client's displayName AND flips jobStatusFilter to
  // ["PAUSED"] so the operator lands directly on that client's paused
  // job list.
  setupSearchEvent("clientsTabToServicesTabSearch", { admin: "services", worker: null });

  // Payments "Job" link → Jobs tab, highlighted to the exact occurrence the
  // payment was recorded against. We send the OCCURRENCE id (plus its
  // startAt for the date anchor) so JobsTab's existing
  // `jobsTab:highlightOcc` handler can call `applyHighlight()` and narrow
  // the view to a single row — much more useful than filtering to the job
  // (which would show every recurring occurrence of that job).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onEvent = (e: Event) => {
      const { forAdmin, entityId, anchorAt } = (e as CustomEvent).detail || {};
      if (!entityId) return;
      pushNavHistory(getCurrentNavState());
      if (forAdmin) {
        setTopTab("admin");
        setAdminInnerTab("jobs");
      } else {
        setTopTab("worker");
        setWorkerInnerTab("jobs");
      }
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
    const onAdminJobs = topTab === "admin" && adminInnerTab === "jobs";
    const onWorkerJobs = topTab === "worker" && workerInnerTab === "jobs";
    if (!onAdminJobs && !onWorkerJobs) return;
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
  }, [topTab, adminInnerTab, workerInnerTab]);

  // Generic tab switcher (used by Audit tab and others to navigate across top-level tabs)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onSwitch = (e: Event) => {
      const { outer, inner } = (e as CustomEvent).detail || {};
      if (outer) setTopTab(outer);
      if (inner && outer === "admin") setAdminInnerTab(inner);
      if (inner && outer === "worker") setWorkerInnerTab(inner);
      if (inner && outer === "super") setSuperInnerTab(inner);
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
      setTopTab("admin");
      setAdminInnerTab("jobs");
      window.sessionStorage.setItem("servicesTabToJobsNav", entityId);
    };
    window.addEventListener("open:servicesTabToJobsTabSearch", onEvent as EventListener);
    return () => window.removeEventListener("open:servicesTabToJobsTabSearch", onEvent as EventListener);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (adminInnerTab !== "jobs") return;
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
  }, [topTab, adminInnerTab]);


  useEffect(() => {
    if (typeof window === "undefined") return;
    if (topTab !== "admin" || adminInnerTab !== "users") return;

    const key = "admin:usersOpenOnce";
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
  }, [topTab, adminInnerTab]);

  const BRAND_ICON_H = 34; // px

  // Earnings shown in the title bar (replaced the weather toggle).
  // Click cycles through Today → Week → Month → All Time.
  // To revert: restore the prior `currentTemp` + `weatherBarVisible` state from git
  // and the Cloud icon button below.
  type EarningsPeriod = "today" | "thisWeek" | "thisMonth" | "allTime";
  // Cycle only walks Today → Week → Month. "allTime" is intentionally
  // omitted — admin/super views show this number; an unbounded "All"
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
    // Skip while a Super is in a client view-as session. The /api/me
    // overlay makes `me` look client-shaped (empty roles, client
    // display name), but the earnings fetch would still go out under
    // the Super's real Clerk token — the server would happily return
    // the SUPER's own earnings, which the pill would then render on
    // top of the view-as shell. That misrepresents what the client
    // actually sees and can leak the operator's own numbers over the
    // client preview. The pill also has no place in a client view;
    // real clients aren't authorized on the underlying endpoint.
    if (me.isClientImpersonating) return;
    // Skip for pure client accounts (no worker/admin/super role) — the
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

  // ---- Pending approvals badge (super only) ----
  // User-management is a Super activity now — admins see the directory
  // read-only and don't need a pending count. Loader bails for non-super
  // so we don't spend an API call we won't render.
  const [pending, setPending] = useState<number>(0);

  const loadPending = useCallback(async () => {
    if (!isSuper) {
      setPending(0);
      markAlertLoaded("pending");
      return;
    }
    try {
      const res = await apiGet<{ pending: number }>(
        "/api/admin/users/pendingCount"
      );
      setPending(res?.pending ?? 0);
    } catch {
      setPending(0);
    }
    markAlertLoaded("pending");
  }, [isSuper]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  // ---- Pending payment approvals badge (admin + super) ----
  const [pendingPayments, setPendingPayments] = useState<number>(0);

  const loadPendingPayments = useCallback(async () => {
    if (!isSuper) {
      setPendingPayments(0);
      markAlertLoaded("pendingPayments");
      return;
    }
    try {
      const list = await apiGet<unknown[]>("/api/admin/payments/pending");
      setPendingPayments(Array.isArray(list) ? list.length : 0);
    } catch {
      setPendingPayments(0);
    }
    markAlertLoaded("pendingPayments");
  }, [isAdmin, isSuper]);

  useEffect(() => {
    void loadPendingPayments();
    // Refresh in-place when any Payment row mutates anywhere in the app
    // — approve, reject, write-off, edit, revert, mark-paid, worker
    // accept-payment, etc. all fire bumpAdminPayments() which emits this
    // event. Without this subscription the "Payments to review" badge
    // stays stale until a hard refresh after an approval.
    const onChanged = () => void loadPendingPayments();
    window.addEventListener("seedlings:admin-payments-changed", onChanged);
    return () => window.removeEventListener("seedlings:admin-payments-changed", onChanged);
  }, [loadPendingPayments]);

  // ---- Pending workday approvals badge (super only) ----
  // State lives near the top of the component (above the tab tree)
  // because the tab JSX reads these synchronously. The loader is
  // defined here next to its peers and registered into the ref so the
  // tab can call it without a forward-reference TDZ.
  // NEEDS_ENDING rows are intentionally excluded from this count —
  // those need a force-end action first; different bucket.
  const loadPendingWorkdays = useCallback(async () => {
    if (!isSuper) {
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
        }>("/api/super/workdays/pending-summary").catch(() => null),
        apiGet<{
          totalPending: number;
          byDate: { entryDate: string; count: number }[];
        }>("/api/super/mileage/pending-summary").catch(() => null),
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
  }, [isSuper]);

  const loadLedgerFollowupCount = useCallback(async () => {
    if (!isSuper) {
      setLedgerFollowupCount(0);
      markAlertLoaded("ledgerFollowups");
      return;
    }
    try {
      const r = await apiGet<{ count: number }>("/api/super/ledger-followups/count");
      setLedgerFollowupCount(r?.count ?? 0);
    } catch {
      setLedgerFollowupCount(0);
    }
    markAlertLoaded("ledgerFollowups");
  }, [isSuper]);

  const loadStreamPauseRemindersCount = useCallback(async () => {
    if (!(isAdmin || isSuper)) {
      setStreamPauseRemindersCount(0);
      markAlertLoaded("streamPauseReminders");
      return;
    }
    try {
      const r = await apiGet<{ count: number }>("/api/admin/stream-pauses/reminders/count");
      setStreamPauseRemindersCount(r?.count ?? 0);
    } catch {
      setStreamPauseRemindersCount(0);
    }
    markAlertLoaded("streamPauseReminders");
  }, [isAdmin, isSuper]);

  const loadGhostExpiryCounts = useCallback(async () => {
    if (!(isAdmin || isSuper)) {
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
  }, [isAdmin, isSuper]);

  const loadDueToRecordCount = useCallback(async () => {
    if (!isSuper) {
      setDueToRecordCount(0);
      markAlertLoaded("dueToRecord");
      return;
    }
    try {
      const r = await apiGet<{ count: number }>("/api/admin/business-expenses/due-soon/count");
      setDueToRecordCount(r?.count ?? 0);
    } catch {
      setDueToRecordCount(0);
    }
    markAlertLoaded("dueToRecord");
  }, [isSuper]);

  const loadPolicyAdminCounts = useCallback(async () => {
    if (!isSuper) {
      setPolicyPendingUploadsCount(0);
      setPolicyPendingApprovalsCount(0);
      markAlertLoaded("policyAdmin");
      return;
    }
    try {
      const r = await apiGet<{ pendingUploadReviews: number; pendingApprovals: number }>(
        "/api/admin/policies/counts",
      );
      setPolicyPendingUploadsCount(r?.pendingUploadReviews ?? 0);
      setPolicyPendingApprovalsCount(r?.pendingApprovals ?? 0);
    } catch {
      setPolicyPendingUploadsCount(0);
      setPolicyPendingApprovalsCount(0);
    }
    markAlertLoaded("policyAdmin");
  }, [isSuper]);

  const loadPolicyWorkerCount = useCallback(async () => {
    // Every signed-in worker (including admins with a workerType) sees
    // this. Admin-only supers with workerType=null get 0 back from the
    // server and the alert simply doesn't render. Skip entirely for
    // pure client accounts — the endpoint is staff-only and 403s.
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
  // cross-tab bus event so the alerts dot stays in sync when a Super
  // flags/resolves a row from the Ledger tab.
  useEffect(() => {
    void loadLedgerFollowupCount();
    const onChanged = () => void loadLedgerFollowupCount();
    window.addEventListener("seedlings:ledger-followups-changed", onChanged);
    return () => window.removeEventListener("seedlings:ledger-followups-changed", onChanged);
  }, [loadLedgerFollowupCount]);

  // Same pattern for the Due-to-Record alert — fires when the Super
  // skips / records / marks-already-recorded a row on the Ledger panel.
  useEffect(() => {
    void loadDueToRecordCount();
    const onChanged = () => void loadDueToRecordCount();
    window.addEventListener("seedlings:due-to-record-changed", onChanged);
    return () => window.removeEventListener("seedlings:due-to-record-changed", onChanged);
  }, [loadDueToRecordCount]);

  // Stream-pause reminders — fires when an admin pauses/updates/resumes
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
  // version state change so the admin-side "pending uploads" badge stays
  // fresh, and the worker-side "documents to sign" badge clears the moment
  // the interceptor fires policies:signed after a successful wizard flow.
  useEffect(() => {
    void loadPolicyAdminCounts();
    void loadPolicyWorkerCount();
    const onSigned = () => {
      void loadPolicyAdminCounts();
      void loadPolicyWorkerCount();
    };
    window.addEventListener("policies:signed", onSigned);
    window.addEventListener("policies:changed", onSigned);
    return () => {
      window.removeEventListener("policies:signed", onSigned);
      window.removeEventListener("policies:changed", onSigned);
    };
  }, [loadPolicyAdminCounts, loadPolicyWorkerCount]);

  // ---- Awaiting-client-payment badge (super only) ----
  // Counts every outstanding payment request — sent to a client, not paid
  // back yet. The worklist on the Super Money Payments tab still flags the
  // stale ones (past PAYMENT_REQUEST_STALE_DAYS) visually; the alert
  // surfaces the full set so a fresh request doesn't sit unseen either.
  const [awaitingClientPaymentCount, setAwaitingClientPaymentCount] = useState<number>(0);
  const [staleRequestCount, setStaleRequestCount] = useState<number>(0);

  const loadAwaitingClientPayment = useCallback(async () => {
    if (!isSuper) {
      setAwaitingClientPaymentCount(0);
      setStaleRequestCount(0);
      markAlertLoaded("awaitingClientPayment");
      return;
    }
    try {
      const list = await apiGet<{ stale: boolean }[]>("/api/admin/payment-requests/outstanding");
      const arr = Array.isArray(list) ? list : [];
      setAwaitingClientPaymentCount(arr.length);
      setStaleRequestCount(arr.filter((r) => r.stale).length);
    } catch {
      setAwaitingClientPaymentCount(0);
      setStaleRequestCount(0);
    }
    markAlertLoaded("awaitingClientPayment");
  }, [isSuper]);

  useEffect(() => {
    void loadAwaitingClientPayment();
    // Same event the pending-approvals counter subscribes to — when a
    // payment lands (approve, admin-mark-paid, etc.), the matching
    // outstanding request disappears from this list, so the badge has
    // to recount too. Kept on the same bus so any payment mutation
    // refreshes both halves of "Payments to review" together.
    const onChanged = () => void loadAwaitingClientPayment();
    window.addEventListener("seedlings:admin-payments-changed", onChanged);
    return () => window.removeEventListener("seedlings:admin-payments-changed", onChanged);
  }, [loadAwaitingClientPayment]);

  // Overdue count for admin header badge — matches Admin Jobs tab
  // overdue logic. Predicate lives in lib/overdueRule so all three
  // overdue sites (this badge, ServicesTab chip, JobsTab chip) stay in
  // sync. PENDING_PAYMENT rows only count once the invoice pay link has
  // expired (per PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS setting) — matches
  // "we can't do anything until the link times out" mental model.
  const [overdueCount, setOverdueCount] = useState(0);
  const loadOverdue = useCallback(async () => {
    if (!isAdmin) { setOverdueCount(0); markAlertLoaded("overdue"); return; }
    try {
      const today = bizToday();
      const toStr = bizYesterday();
      const fromStr = bizAddDays(today, -60);
      const [list, expiryHours] = await Promise.all([
        apiGet<any[]>(`/api/occurrences?from=${fromStr}&to=${toStr}`),
        loadPaymentRequestExpiryHours(),
      ]);
      const nowMs = Date.now();
      const count = (Array.isArray(list) ? list : []).filter((o) =>
        isOccurrenceOverdue(o, { todayKey: today, expiryHours, nowMs })
        // Extra 60-day lower bound preserves the badge's existing
        // scope (don't scan ancient history for the alert count).
        && o.startAt && bizDateKey(o.startAt) >= fromStr,
      ).length;
      setOverdueCount(count);
    } catch {
      setOverdueCount(0);
    }
    markAlertLoaded("overdue");
  }, [isAdmin]);

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
    if (!isAdmin) { setChangeRequestCount(0); markAlertLoaded("changeRequests"); return; }
    try {
      const result = await apiGet<{ count: number }>("/api/admin/change-requests/pending-count");
      setChangeRequestCount(result?.count ?? 0);
    } catch {
      setChangeRequestCount(0);
    }
    markAlertLoaded("changeRequests");
  }, [isAdmin]);
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
    // Always mark loaded on early-exit — for non-admin users, isAdmin
    // stays false and the [isAdmin] dep never triggers a re-fire, so
    // gating on `if (me)` here can leave the badge stuck pulsating.
    if (!isAdmin) {
      setEstimateFollowupCount(0);
      markAlertLoaded("estimateFollowups");
      return;
    }
    try {
      const result = await apiGet<{ count: number }>("/api/admin/estimates/stale-followup-count");
      setEstimateFollowupCount(result?.count ?? 0);
    } catch {
      setEstimateFollowupCount(0);
    }
    markAlertLoaded("estimateFollowups");
  }, [isAdmin]);
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
    if (!isAdmin) {
      setUnapprovedHoursCount(0);
      markAlertLoaded("unapprovedHours");
      return;
    }
    try {
      const result = await apiGet<{ count: number }>("/api/admin/occurrences/unapproved-hours-count");
      setUnapprovedHoursCount(result?.count ?? 0);
    } catch {
      setUnapprovedHoursCount(0);
    }
    markAlertLoaded("unapprovedHours");
  }, [isAdmin]);
  useEffect(() => {
    void loadUnapprovedHoursCount();
    const onRefresh = () => void loadUnapprovedHoursCount();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadUnapprovedHoursCount]);

  // Education guides awaiting approval. SUPER-only: approving is the only
  // way material becomes readable, so a pending guide is work blocked on
  // the Super and nobody else can clear it.
  const [guideApprovalCount, setGuideApprovalCount] = useState(0);
  const loadGuideApprovalCount = useCallback(async () => {
    if (!isSuper) {
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
  }, [isSuper]);
  useEffect(() => {
    void loadGuideApprovalCount();
    const onRefresh = () => void loadGuideApprovalCount();
    window.addEventListener("seedlings:guides-changed", onRefresh);
    return () => window.removeEventListener("seedlings:guides-changed", onRefresh);
  }, [loadGuideApprovalCount]);

  // Super → Records → Guides, where the review queue lives.
  const goToGuideApprovals = useCallback(() => {
    setTopTab("super");
    setSuperCategory("Records");
    setSuperInnerTab("guides");
  }, []);

  // Unlinked client accounts. This was a Tasks section with NO dropdown
  // alert — the only such gap — so an operator who never opened Tasks had
  // no signal at all. Added 2026-08-26 when the two surfaces were
  // reconciled; see the alert-ordering build gate.
  const [unlinkedAccountsCount, setUnlinkedAccountsCount] = useState(0);
  const loadUnlinkedAccountsCount = useCallback(async () => {
    if (!isAdmin) {
      setUnlinkedAccountsCount(0);
      markAlertLoaded("unlinkedAccounts");
      return;
    }
    try {
      const list = await apiGet<unknown[]>("/api/admin/clients/unlinked-accounts");
      setUnlinkedAccountsCount(Array.isArray(list) ? list.length : 0);
    } catch {
      setUnlinkedAccountsCount(0);
    }
    markAlertLoaded("unlinkedAccounts");
  }, [isAdmin]);
  useEffect(() => {
    void loadUnlinkedAccountsCount();
    const onRefresh = () => void loadUnlinkedAccountsCount();
    window.addEventListener("seedlings:client-accounts-changed", onRefresh);
    return () => window.removeEventListener("seedlings:client-accounts-changed", onRefresh);
  }, [loadUnlinkedAccountsCount]);

  // Payroll names awaiting identity matching. SUPER-only: matching a name
  // to a User is the one payroll action that changes who can see whose pay,
  // so it sits behind the same guard as the import itself.
  //
  // This count is not cosmetic. Until a name is matched, THAT WORKER CANNOT
  // SEE THEIR OWN PAY — and the worker's only signal is a passive "ask your
  // admin" line, because they are deliberately never told whose row it is.
  // Before this existed the queue was visible only inside the Payroll tab,
  // so the one person who could fix it had to happen to go looking, while
  // the person affected was told to go ask them.
  const [payrollUnmatchedCount, setPayrollUnmatchedCount] = useState(0);
  const loadPayrollUnmatchedCount = useCallback(async () => {
    if (!isSuper) {
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
  }, [isSuper]);
  useEffect(() => {
    void loadPayrollUnmatchedCount();
    // An import adds names to the queue; a match removes one. Both fire
    // this, so the badge settles without a manual refresh.
    const onRefresh = () => void loadPayrollUnmatchedCount();
    window.addEventListener("seedlings:payroll-changed", onRefresh);
    return () => window.removeEventListener("seedlings:payroll-changed", onRefresh);
  }, [loadPayrollUnmatchedCount]);

  // Super → Money → Payroll, where the review queue lives.
  const goToPayrollIdentities = useCallback(() => {
    setTopTab("super");
    setSuperCategory("Money");
    setSuperInnerTab("payroll");
  }, []);

  // Navigate to admin Jobs tab filtered to unapproved-hours occurrences.
  // Same handoff pattern as overdue / estimate-followups: localStorage flag
  // for mount-time pickup + dispatched event for already-mounted case.
  /**
   * Navigate to a surface that exists for BOTH Admin and Super, without
   * changing the role the operator is acting as.
   *
   * Alert handlers used to hardcode `setTopTab("admin")`, so a Super who
   * clicked "Overdue" or "Unclaimed" was silently demoted to the Admin
   * tab — different sections, different affordances, and no way to tell
   * why (reported 2026-08-27).
   *
   * Branches on the CURRENT top tab, not on which roles the user holds:
   * a Super deliberately acting as Admin should stay on Admin too.
   * `superTab` is optional because a few surfaces genuinely have no Super
   * equivalent (Services is the one today), and those must fall through
   * to Admin rather than land nowhere.
   */
  const gotoOperatorSurface = useCallback(
    (opts: {
      superTab?: string;
      superCategory?: string;
      adminTab: string;
      adminCategory?: string;
    }) => {
      if (topTab === "super" && opts.superTab) {
        setTopTab("super");
        if (opts.superCategory) setSuperCategory(opts.superCategory as any);
        setSuperInnerTab(opts.superTab as any);
        return;
      }
      setTopTab("admin");
      if (opts.adminCategory) setAdminCategory(opts.adminCategory as any);
      setAdminInnerTab(opts.adminTab as any);
    },
    [topTab],
  );

  const goToUnapprovedHours = useCallback(() => {
    try {
      localStorage.setItem("seedlings_adminJobs_showUnapprovedHours", "1");
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ superTab: "jobs", superCategory: "Work", adminTab: "jobs" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showUnapprovedHours"));
    }, 100);
  }, [gotoOperatorSurface]);

  // Navigate to admin Jobs tab with the estimate-followup filter applied.
  // Mirrors goToOverdue / goToUnclaimed: writes a flag to localStorage so
  // the tab picks it up on mount, then fires an event in case it's already
  // mounted.
  const goToEstimateFollowups = useCallback(() => {
    try {
      localStorage.setItem("seedlings_adminJobs_showEstimateFollowups", "1");
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ superTab: "jobs", superCategory: "Work", adminTab: "jobs" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showEstimateFollowups"));
    }, 100);
  }, [gotoOperatorSurface]);

  // Unclaimed count for admin header badge
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const loadUnclaimed = useCallback(async () => {
    if (!isAdmin) { setUnclaimedCount(0); markAlertLoaded("unclaimed"); return; }
    try {
      const d = computeDatesFromPreset("overdueAndNext3");
      const qs = new URLSearchParams();
      if (d.from) qs.set("from", d.from);
      if (d.to) qs.set("to", d.to);
      const result = await apiGet<{ jobs: { unclaimed: number } }>(`/api/admin/operations?${qs}`);
      setUnclaimedCount(result?.jobs?.unclaimed ?? 0);
    } catch {
      setUnclaimedCount(0);
    }
    markAlertLoaded("unclaimed");
  }, [isAdmin]);

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
  const alertsReady = !!(alertsLoaded.pending && alertsLoaded.overdue && alertsLoaded.unclaimed && alertsLoaded.announcements && alertsLoaded.pendingPayments && alertsLoaded.awaitingClientPayment && alertsLoaded.changeRequests && alertsLoaded.estimateFollowups && alertsLoaded.unapprovedHours && alertsLoaded.pendingWorkdays && alertsLoaded.ledgerFollowups && alertsLoaded.dueToRecord && alertsLoaded.streamPauseReminders && alertsLoaded.ghostExpiry && alertsLoaded.policyAdmin && alertsLoaded.policyWorker && alertsLoaded.timeline && alertsLoaded.payrollUnmatched && alertsLoaded.unlinkedAccounts && alertsLoaded.guideApprovals);
  const markAlertLoaded = useCallback((key: string) => setAlertsLoaded((prev) => prev[key] ? prev : { ...prev, [key]: true }), []);
  const loadAnnouncementCount = useCallback(async () => {
    // Staff-only: /api/occurrences requires a worker/admin/super role.
    // Client-only accounts would just 403 in a loop.
    if (!me?.isApproved || !hasAnyRole) { setAnnouncementCount(0); if (me) markAlertLoaded("announcements"); return; }
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
    setTopTab("worker");
    setWorkerInnerTab("jobs" as any);
    try { localStorage.setItem("seedlings_adminJobs_showAnnouncements", "1"); } catch {}
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showAnnouncements"));
    }, 150);
  }, []);

  const goToUnclaimed = useCallback(() => {
    gotoOperatorSurface({ superTab: "jobs", superCategory: "Work", adminTab: "jobs" });
    // Signal the Jobs tab to apply unclaimed filter
    try { localStorage.setItem("seedlings_adminJobs_showUnclaimed", "1"); } catch {}
    // Also dispatch event in case the tab is already mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showUnclaimed"));
    }, 50);
  }, [gotoOperatorSurface]);

  const goToOverdue = useCallback(() => {
    try {
      localStorage.setItem("seedlings_adminJobs_showOverdue", "1");
      // Clear the "View as" user filter so all overdue jobs are shown
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ superTab: "jobs", superCategory: "Work", adminTab: "jobs" });
    // Also dispatch event for when component is already mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showOverdue"));
    }, 100);
  }, [gotoOperatorSurface]);

  // Next-visit ghost alerts → Jobs, narrowed to the matching placeholder
  // bucket. Same localStorage-flag-plus-event shape as goToOverdue: the flag
  // covers a cold mount, the event covers an already-mounted tab.
  const goToGhostBucket = useCallback((bucket: "expiring" | "expired") => {
    const key = bucket === "expired"
      ? "seedlings_adminJobs_showExpiredGhosts"
      : "seedlings_adminJobs_showExpiringGhosts";
    try {
      localStorage.setItem(key, "1");
      // Clear "View as" so every matching ghost shows, not just one
      // worker's — mirrors goToOverdue.
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    gotoOperatorSurface({ superTab: "jobs", superCategory: "Work", adminTab: "jobs" });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(
        bucket === "expired" ? "adminJobs:showExpiredGhosts" : "adminJobs:showExpiringGhosts",
      ));
    }, 100);
  }, [gotoOperatorSurface]);
  const goToExpiringGhosts = useCallback(() => goToGhostBucket("expiring"), [goToGhostBucket]);
  const goToExpiredGhosts = useCallback(() => goToGhostBucket("expired"), [goToGhostBucket]);

  // Jump to the admin Jobs tab and scroll to the Client Requests section.
  // The section is mounted at the top of the Jobs view for admins, so we
  // navigate there and then scroll-into-view its anchor.
  const goToClientRequests = useCallback(() => {
    gotoOperatorSurface({ superTab: "jobs", superCategory: "Work", adminTab: "jobs" });
    setTimeout(() => {
      const el = document.getElementById("client-requests-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }, [gotoOperatorSurface]);

  // Lands on Admin → Directory → Clients where the
  // UnlinkedClientAccountsSection is hosted. Used by Tasks page's
  // collapsible card's "Goto Task" icon button so the operator can
  // jump to the section's home tab if they prefer working there.
  const goToUnlinkedAccounts = useCallback(() => {
    gotoOperatorSurface({
      superTab: "clients",
      superCategory: "Directory",
      adminTab: "clients",
      adminCategory: "Directory",
    });
  }, [gotoOperatorSurface]);

  // Timeline alert — merged count of urgent timeline events + expiring
  // documents (urgent = past or ≤7 days). Super uses /super/ for the full
  // view including hidden items; admin uses /admin/ which filters hidden
  // server-side.
  const [timelineUrgentCount, setTimelineUrgentCount] = useState(0);
  const loadTimelineCount = useCallback(async () => {
    if (!isAdmin) { setTimelineUrgentCount(0); if (me) markAlertLoaded("timeline"); return; }
    try {
      // Scope by the ROLE CHIP the operator is on (`scopeIsSuper`), not by
      // their underlying role. The super endpoint includes adminHidden
      // events; the admin one doesn't — and goToTimeline lands on whichever
      // tab tree the chip selects. Keying off `isSuper` meant a super
      // sitting on the Admin chip got a badge counting super-only rows and
      // a list that couldn't show them: the badge said 2, the tab showed 1.
      const endpoint = scopeIsSuper
        ? "/api/super/timeline/upcoming-counts"
        : "/api/admin/timeline/upcoming-counts";
      const r = await apiGet<{ urgent: number; soon: number }>(endpoint);
      setTimelineUrgentCount(r?.urgent ?? 0);
    } catch {
      setTimelineUrgentCount(0);
    }
    markAlertLoaded("timeline");
  }, [isAdmin, scopeIsSuper, me]);

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
        // to sign" or the admin-side compliance queues. The worker who
        // signed a policy on another device would see the stale count
        // until they closed the browser tab. Reported on 2026-07-13.
        loadPolicyWorkerCount(),
        loadPolicyAdminCounts(),
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
    loadPolicyWorkerCount, loadPolicyAdminCounts,
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
    gotoOperatorSurface({
      superTab: "timeline",
      superCategory: "Records",
      adminTab: "timeline",
      adminCategory: "Records",
    });
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

      // SUPER, not admin. User management is Super-only, and both
      // dispatchers of this event already route there — this listener was
      // the stale one, and because it fires on a 100ms timeout it ran
      // AFTER the handler's own navigation and quietly overrode it. That
      // is why the "Pending Users" alert landed on the Admin Users tab
      // (reported 2026-08-27), which no longer even has the pending
      // section.
      setTopTab("super");
      setSuperCategory("Directory");
      setSuperInnerTab("users");

      window.sessionStorage.setItem(
        "admin:usersOpenOnce",
        JSON.stringify({ status })
      );
    };

    window.addEventListener("admin:openUsers", onOpenUsers as EventListener);
    return () =>
      window.removeEventListener(
        "admin:openUsers",
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
      const { userId, forAdmin } = (e as CustomEvent).detail || {};
      // Push the current tab onto the nav history stack BEFORE switching
      // so the back button (in-app or browser/OS gesture) can return the
      // user to where they were. Every other programmatic tab switch
      // that participates in back-navigation uses pushNavHistory; this
      // handler was previously missing it, so "View profile" jumps into
      // Profile but the back button has no state to restore.
      pushNavHistory(getCurrentNavState());
      if (forAdmin && isAdmin) {
        setTopTab("admin");
        setAdminInnerTab("profile");
        // Set the selected user in profile via localStorage (ProfileTab reads it)
        try { localStorage.setItem("seedlings_profile_userId", JSON.stringify(userId === me?.id ? "" : userId)); } catch {}
        window.dispatchEvent(new CustomEvent("profile:selectUser", { detail: { userId } }));
      } else {
        setTopTab("worker");
        setWorkerInnerTab("profile");
      }
    };
    window.addEventListener("navigate:profile", onProfile as EventListener);
    return () => window.removeEventListener("navigate:profile", onProfile as EventListener);
  }, [isAdmin, me?.id]);

  // Listen for worker tab navigation (from Reminders → Routes, etc.)
  const programmaticNavRef = useRef(false);
  useEffect(() => {
    const onNav = (e: Event) => {
      const { tab, category, autoAnalyze, filter, remount } = (e as CustomEvent).detail || {};
      if (tab) {
        // Record the current location to history before navigating, so back button works
        const current = getCurrentNavState();
        const targetCategory = category ?? (topTab === "worker" ? workerCategory : workerCategoryRef.current);
        const wouldChange = current.outer !== "worker" || current.inner !== tab || (category && current.category !== category);
        if (wouldChange) pushNavHistory(current);
        programmaticNavRef.current = true;
        setTopTab("worker");
        setWorkerInnerTab(tab);
        if (category) setWorkerCategory(category);
        // Remount the destination tab so its persisted-state hooks re-read localStorage
        // (which the caller has just pre-written with the desired filter values).
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
        // Legacy: event-driven filter for flows that haven't switched to the remount pattern yet.
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
        // Reset flag after React processes the state update
        setTimeout(() => { programmaticNavRef.current = false; }, 50);
      }
    };
    window.addEventListener("navigate:workerTab", onNav as EventListener);
    return () => window.removeEventListener("navigate:workerTab", onNav as EventListener);
  }, []);

  // Mirror handler for admin tab navigation. Used by HomeTab's tile click-throughs
  // (which target admin tabs filtered to the impersonated worker). Same remount-on-demand
  // pattern as the worker version — caller pre-writes localStorage, we bump the key.
  // Also updates adminCategory when the destination tab lives in a different category
  // than the current one — otherwise the category nav stays on the old category and
  // the inner-tab bar can render the wrong set of tabs.
  useEffect(() => {
    const adminCatMap: Record<string, string> = {
      home: "Work", jobs: "Work", routes: "Work", services: "Work", tasks: "Work",
      equipment: "Equipment", collections: "Equipment", vehicles: "Equipment",
      clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
      payments: "Money", payroll: "Money", pricing: "Money", supplies: "Money",
      activity: "Records", history: "Records", timeline: "Records", documents: "Records", guides: "Records",
      notify: "System", settings: "System", profile: "System",
    };
    const onNav = (e: Event) => {
      const { tab, remount } = (e as CustomEvent).detail || {};
      if (!tab) return;
      const current = getCurrentNavState();
      const wouldChange = current.outer !== "admin" || current.inner !== tab;
      if (wouldChange) pushNavHistory(current);
      programmaticNavRef.current = true;
      setTopTab("admin");
      setAdminInnerTab(tab as any);
      const destCategory = adminCatMap[tab];
      if (destCategory) setAdminCategory(destCategory);
      if (remount) {
        if (tab === "jobs") setAdminJobsRemountKey((k) => k + 1);
        else if (tab === "equipment") setAdminEquipmentRemountKey((k) => k + 1);
        else if (tab === "payments") setAdminPaymentsRemountKey((k) => k + 1);
      }
      setTimeout(() => { programmaticNavRef.current = false; }, 50);
    };
    window.addEventListener("navigate:adminTab", onNav as EventListener);
    return () => window.removeEventListener("navigate:adminTab", onNav as EventListener);
  }, []);

  // navigate:superTab — handoff from any tab into a Super inner tab (e.g.
  // BusinessExpensesTab clicking the "Supply: Mulch ×10" badge to land on
  // Super → Supplies). Mirrors the navigate:adminTab pattern; the receiving
  // tab reads its own pendingHighlight key on mount.
  //
  // Category map matches the Super category strip; kept in sync with the
  // Super tab tree above so a cross-tab jump also switches the category
  // nav to reveal the destination. Also mirrors admin's remount handling
  // so cross-tab handoffs that need a fresh mount (e.g. clearing per-mount
  // state) work identically in super scope.
  useEffect(() => {
    // Kept in sync with the super tab tree above — every super inner
    // tab needs an entry so cross-tab handoffs route to the right
    // category strip. Values must match `category:` on the tab entry.
    const superCatMap: Record<string, string> = {
      home: "Work", jobs: "Work", routes: "Work", services: "Work", tasks: "Work",
      equipment: "Equipment", collections: "Equipment", vehicles: "Equipment",
      clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
      payments: "Money", payroll: "Money", pricing: "Money", supplies: "Money", ledger: "Money", promotions: "Money", forecast: "Money",
      reconcile: "Records", workdays: "Records", compliance: "Records", activity: "Records",
      history: "Records", timeline: "Records", documents: "Records", guides: "Records", audit: "Records",
      "tools-mowing": "Tools", "tools-mulch": "Tools",
      notify: "System", settings: "System", profile: "System", vanity: "System",
    };
    const onNav = (e: Event) => {
      const { tab, remount } = (e as CustomEvent).detail || {};
      if (!tab) return;
      const current = getCurrentNavState();
      const wouldChange = current.outer !== "super" || current.inner !== tab;
      if (wouldChange) pushNavHistory(current);
      programmaticNavRef.current = true;
      setTopTab("super");
      setSuperInnerTab(tab as any);
      const destCategory = superCatMap[tab];
      if (destCategory) setSuperCategory(destCategory);
      if (remount) {
        if (tab === "jobs") setAdminJobsRemountKey((k) => k + 1);
        else if (tab === "equipment") setAdminEquipmentRemountKey((k) => k + 1);
        else if (tab === "payments") setAdminPaymentsRemountKey((k) => k + 1);
      }
      setTimeout(() => { programmaticNavRef.current = false; }, 50);
    };
    window.addEventListener("navigate:superTab", onNav as EventListener);
    return () => window.removeEventListener("navigate:superTab", onNav as EventListener);
  }, []);

  // Listen for "launch New Job Setup with estimate defaults" from JobsTab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setWorkflowEstimateDefaults(detail ?? null);
      setTopTab("admin");
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
      setTopTab("worker");
      setWorkerInnerTab("tasks");
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
    if (!isSignedIn) return; // Wait for auth; URL stays intact across redirect.

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
    const outerVisible = typeof outer.visible === "function" ? outer.visible() : outer.visible;
    if (!outerVisible) {
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
      // is used (the matched.category that flows through to setWorkerCategory
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
      setWorkerInnerTab(matched.value as any);
      if (matched.category) setWorkerCategory(matched.category);
    } else if (outerValue === "admin") {
      setAdminInnerTab(matched.value as any);
      if (matched.category) setAdminCategory(matched.category);
    } else if (outerValue === "super") {
      setSuperInnerTab(matched.value as any);
      if (matched.category) setSuperCategory(matched.category);
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
    const view = router.query.view as string | undefined;
    const at = router.query.at as string | undefined;
    if (occId) {
      try {
        localStorage.setItem("seedlings_deeplink_occ", occId);
        if (view) localStorage.setItem("seedlings_deeplink_view", view);
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
    const view = router.query.view as string | undefined;
    if (equipmentId) {
      try {
        localStorage.setItem("seedlings_deeplink_equipment", equipmentId);
        if (view) localStorage.setItem("seedlings_deeplink_equipment_view", view);
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
  // to Super → Documents if the user is Super, else Admin → Documents. Then
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
    const onAdminDocs = topTab === "admin" && adminInnerTab === "documents";
    const onSuperDocs = topTab === "super" && superInnerTab === "documents";
    if (!onAdminDocs && !onSuperDocs) {
      if (isSuper) {
        setTopTab("super");
        setSuperInnerTab("documents" as any);
        setSuperCategory("Records");
      } else if (isAdmin) {
        setTopTab("admin");
        setAdminInnerTab("documents" as any);
        setAdminCategory("Records");
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
  }, [me?.isApproved, meLoading, isSuper, isAdmin]);

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
    const onAdminTimeline = topTab === "admin" && adminInnerTab === "timeline";
    const onSuperTimeline = topTab === "super" && superInnerTab === "timeline";
    if (!onAdminTimeline && !onSuperTimeline) {
      if (isSuper) {
        setTopTab("super");
        setSuperInnerTab("timeline" as any);
        setSuperCategory("Records");
      } else if (isAdmin) {
        setTopTab("admin");
        setAdminInnerTab("timeline" as any);
        setAdminCategory("Records");
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
  }, [me?.isApproved, meLoading, isSuper, isAdmin]);

  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let occId: string | null = null;
    let view: string | null = null;
    let anchorAt: string | null = null;
    try {
      occId = localStorage.getItem("seedlings_deeplink_occ");
      view = localStorage.getItem("seedlings_deeplink_view");
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
    if (view === "admin") {
      setTopTab("admin");
      setAdminInnerTab("jobs");
    } else {
      setTopTab("worker");
      setWorkerInnerTab("jobs" as any);
    }
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
        if (view !== "admin") {
          window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "jobs" } }));
        }
        window.dispatchEvent(new CustomEvent("jobsTab:highlightOcc", { detail: { occId: savedOccId, anchorAt: savedAnchor } }));
      }
    }, 100);
    return () => clearInterval(interval);
  }, [me?.isApproved, meLoading]);

  // Consume ?equipment=<id> deep link after auth.
  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let equipmentId: string | null = null;
    let view: string | null = null;
    try {
      equipmentId = localStorage.getItem("seedlings_deeplink_equipment");
      view = localStorage.getItem("seedlings_deeplink_equipment_view");
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
    if (view === "admin") {
      setTopTab("admin");
      setAdminInnerTab("equipment" as any);
    } else {
      setTopTab("worker");
      setWorkerInnerTab("equipment");
      setWorkerCategory("Equipment");
    }
    const savedId = equipmentId;
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__equipmentTabReady || attempts >= maxAttempts) {
        clearInterval(interval);
        if (view !== "admin") {
          window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "equipment" } }));
        }
        window.dispatchEvent(new CustomEvent("equipmentTab:highlight", { detail: { equipmentId: savedId } }));
      }
    }, 100);
    return () => clearInterval(interval);
  }, [me?.isApproved, meLoading]);

  const goToApprovals = useCallback(() => {
    // User management is now a Super-only activity. The "Pending Users"
    // alert chip in the title bar (also super-gated) routes here.
    // Include `role: "all"` in the payload so the persisted role filter
    // (worker/admin/client) is reset on arrival — otherwise the alert
    // would land on a screen filtered to a role the new sign-up doesn't
    // have, and the Pending section would silently show zero rows
    // despite the alert badge reading a positive count.
    window.sessionStorage.setItem("admin:usersOpenOnce", JSON.stringify({ status: "pending", role: "all" }));
    setTopTab("super");
    // The CATEGORY has to move too. Without it the super category stayed
    // wherever it was, "users" didn't resolve under it, and the app fell
    // back — landing the operator on the Admin Users tab instead of the
    // Super one (reported 2026-08-27). That got worse the moment PENDING
    // SIGN-UPS became Super-only: the alert was routing to the one screen
    // that no longer has the section it was pointing at.
    setSuperCategory("Directory");
    setSuperInnerTab("users");
    // Also dispatch event for when component is already mounted
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("admin:openUsers", {
          detail: { status: "pending" as const, role: "all" as const },
        })
      );
    }, 100);
  }, []);

  const goToPaymentApprovals = useCallback(() => {
    setTopTab("super");
    setSuperInnerTab("payments");
  }, []);

  // Jump to Workdays tab and (when there are pending approvals) point
  // the tab at the OLDEST pending day so Super starts where the
  // backlog begins. State for the jump (workdaysJumpDate / Nonce) is
  // declared near the top of the component; this just bumps it.
  const goToWorkdayApprovals = useCallback(() => {
    setTopTab("super");
    setSuperInnerTab("workdays");
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

  // Land on Super → Money → Ledger with the "Followups only" filter
  // pre-applied. The Ledger tab listens for this event on mount and
  // flips its filter chip on. A short timeout gives the tab content
  // a tick to mount before the event fires (event before subscribe ⇒
  // missed signal).
  const goToLedgerFollowups = useCallback(() => {
    setTopTab("super");
    setSuperCategory("Money");
    setSuperInnerTab("ledger" as any);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("seedlings:open-ledger-followups"));
    }, 150);
  }, []);

  // Land on Super → Money → Ledger — the Due-to-Record panel is pinned
  // at the top of that tab, so just landing there surfaces it. No deep-
  // link event needed (the panel isn't behind a filter chip).
  const goToDueToRecord = useCallback(() => {
    setTopTab("super");
    setSuperCategory("Money");
    setSuperInnerTab("ledger" as any);
  }, []);

  // Super → Records → Compliance. Both compliance alerts (pending
  // upload reviews, pending version approvals) land here — the tab
  // surfaces each in its own section so the operator sees both at once.
  const goToCompliance = useCallback(() => {
    setTopTab("super");
    setSuperCategory("Records");
    setSuperInnerTab("compliance");
  }, []);

  // Worker → Profile. The worker Compliance section at the top of the
  // profile page auto-opens the sign wizard when the "Sign now" button
  // is pressed, so landing here is one click away from signing.
  const goToWorkerCompliance = useCallback(() => {
    setTopTab("worker");
    setWorkerInnerTab("profile");
    setWorkerCategory("System");
  }, []);

  // Stream-pause reminders — land on the Admin Services tab where the
  // paused stream cards live (mounted with purpose="ADMIN"). Super's
  // innerTabs list has NO "services" entry, so the previous
  // `setSuperInnerTab("services")` silently fell back to the Super
  // Home tab (Operations pulse). Route both roles through Admin —
  // Super users in this app also carry the Admin role.
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
    // a Super clicking this alert kept getting demoted to Admin.
    gotoOperatorSurface({
      superTab: "services",
      superCategory: "Work",
      adminTab: "services",
    });
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
      {/* Super-only impersonation banner — sits above the Container so it
          spans the full viewport width and sticks to the top of every page. */}
      <ImpersonationBanner me={me} />
    <Container maxW="5xl" px={{ base: 3, md: 4 }} pt={3} pb={6}>
      {isDev && (
        <Box
          position="fixed"
          bottom="4"
          right="4"
          zIndex="9999"
          bg="red.500"
          color="white"
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
        bg="#dce5d0"
        bgGradient="linear(to-b, #dce5d0, #e8eedf)"
        borderWidth="2px"
        borderColor="#8a9e72"
        px={{ base: 2.5, md: 3.5 }}
        py={{ base: 2, md: 2.5 }}
        borderRadius="md"
        mb={1}
      >
        {/* GRID header: left brand, center temp, right controls */}
        <Box
          display="grid"
          gridTemplateColumns="1fr 1fr"
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
                    if (topTab === "worker") setWorkerInnerTab("home" as any);
                    else if (topTab === "admin") setAdminInnerTab("home" as any);
                    else if (topTab === "super") setSuperInnerTab("home" as any);
                    // Client tab tree has no "home" value — the tab stays
                    // where it is (no-op).
                  }}
                  _hover={{ opacity: 0.8 }}
                >
                  {/* Show "Seedlings" text only when the user actually IS a
                      client — either not signed in, or signed in with no
                      staff role. A staff user (worker/admin/super) who
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
                    bg="purple.500"
                    color="white"
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
            {/* On-the-clock bubble — mounted only for staff (worker/admin/
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
                bg="blue.50"
                color="blue.700"
                _hover={{ bg: "blue.100" }}
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
                bg="green.50"
                color="green.700"
                _hover={{ bg: "green.100" }}
                title={`Earnings (${EARNINGS_LABELS[earningsPeriod]}) — click to cycle period`}
                onClick={cycleEarningsPeriod}
              >
                <Text fontSize="sm" fontWeight="semibold" lineHeight="1" whiteSpace="nowrap">
                  ${fmtEarnings(earnings[earningsPeriod])}
                  <Text as="span" fontSize="2xs" fontWeight="medium" color="green.600" ml={1}>{EARNINGS_LABELS[earningsPeriod]}</Text>
                </Text>
              </Box>
            )}
            */}

            {/* Role selector — renders BEFORE the alerts badge so the
                order reads: role → alerts → avatar. Hidden when the user
                has zero or one role; multi-role users get a compact chip
                + dropdown. Switching preserves the current inner tab
                when the same tab exists in the target role. */}
            {mounted && isSignedIn && hasAnyRole && availableRoles.length > 1 && (
              <RoleChip
                activeRole={topTab as RoleValue}
                availableRoles={availableRoles}
                onSwitch={switchRole}
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
                bg="#EF4444"
                display="flex"
                alignItems="center"
                justifyContent="center"
                style={{ animation: "alert-pulse 1.2s ease-in-out infinite" }}
              >
                <style>{`@keyframes alert-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.9); } }`}</style>
                <Box w="6px" h="6px" borderRadius="full" bg="white" />
              </Box>
            )}
            {hasAnyRole && alertsReady && (() => {
              // Alert visibility keys off SCOPED role vars (scopeIsAdmin
              // / scopeIsSuper) rather than the raw underlying flags —
              // so a Super acting as Worker doesn't see admin/super
              // alerts they can't act on from the current tab. See the
              // scope var definitions near the top of this component.
              const alerts: { label: string; count: number; bg: string; color: string; dotColor: string; onClick: () => void }[] = [];
              if (scopeIsAdmin && overdueCount > 0) alerts.push({ label: "Overdue", count: overdueCount, bg: "#FEE2E2", color: "#991B1B", dotColor: "#EF4444", onClick: goToOverdue });
              if (scopeIsSuper && pending > 0) alerts.push({ label: "Pending Users", count: pending, bg: "#FFEDD5", color: "#9A3412", dotColor: "#FB923C", onClick: goToApprovals });
              // Payments to review — combined alert that rolls up
              // pending-admin-approval payments + outstanding client
              // payment requests. Both used to be separate entries
              // that routed to the same Super → Payments tab, so we
              // collapsed them into a single, generically-named item.
              // Stale-aware color: when ANY outstanding request has
              // aged past the threshold, the alert switches to orange
              // tones as a visual prompt to follow up — same logic
              // the old "Awaiting payment" entry used.
              if (scopeIsSuper) {
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
              if (scopeIsSuper && pendingWorkdays + pendingMileage > 0) {
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
              if (scopeIsSuper && ledgerFollowupCount > 0) alerts.push({ label: "Ledger followups", count: ledgerFollowupCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToLedgerFollowups });
              if (scopeIsSuper && dueToRecordCount > 0) alerts.push({ label: "Due to record", count: dueToRecordCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToDueToRecord });
              if (scopeIsAdmin && streamPauseRemindersCount > 0) alerts.push({ label: "Paused repeating to review", count: streamPauseRemindersCount, bg: "#F3E8FF", color: "#6B21A8", dotColor: "#A855F7", onClick: goToStreamPauseReminders });
              // Next-visit placeholders. Gray on purpose — it's the ghost
              // card's own color, so the alert and the cards it lands on
              // read as the same thing. Expired is the darker of the two.
              if (scopeIsAdmin && ghostExpiringCount > 0) alerts.push({ label: "Next visits expiring", count: ghostExpiringCount, bg: "#F3F4F6", color: "#374151", dotColor: "#6B7280", onClick: goToExpiringGhosts });
              if (scopeIsAdmin && ghostExpiredCount > 0) alerts.push({ label: "Next visits expired", count: ghostExpiredCount, bg: "#E5E7EB", color: "#111827", dotColor: "#374151", onClick: goToExpiredGhosts });
              if (scopeIsSuper && policyPendingUploadsCount > 0) alerts.push({ label: "Compliance uploads to review", count: policyPendingUploadsCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToCompliance });
              if (scopeIsSuper && policyPendingApprovalsCount > 0) alerts.push({ label: "Policy versions awaiting approval", count: policyPendingApprovalsCount, bg: "#DBEAFE", color: "#1E3A8A", dotColor: "#3B82F6", onClick: goToCompliance });
              // "Documents to sign" is a per-user obligation, so it
              // surfaces on any tab where the user is authenticated as
              // themselves — worker / admin / super all sign policies.
              // No scope gate.
              if (policyWorkerPendingCount > 0) alerts.push({ label: "Documents to sign", count: policyWorkerPendingCount, bg: "#FEE2E2", color: "#7F1D1D", dotColor: "#DC2626", onClick: goToWorkerCompliance });
              if (scopeIsAdmin && changeRequestCount > 0) alerts.push({ label: "Client requests", count: changeRequestCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToClientRequests });
              if (scopeIsAdmin && unlinkedAccountsCount > 0) alerts.push({ label: "Unlinked client accounts", count: unlinkedAccountsCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToUnlinkedAccounts });
              if (scopeIsAdmin && estimateFollowupCount > 0) alerts.push({ label: "Estimate follow-ups", count: estimateFollowupCount, bg: "#FCE7F3", color: "#9D174D", dotColor: "#EC4899", onClick: goToEstimateFollowups });
              // The two payroll queues sit together: this one blocks a
              // worker from seeing their pay, the next holds hours back
              // from the Gusto export. Purple matches the Payroll tab's
              // employer-cost accent, so the colour reads as "payroll"
              // rather than as a severity.
              if (scopeIsSuper && payrollUnmatchedCount > 0) alerts.push({ label: "Payroll names to match", count: payrollUnmatchedCount, bg: "#F3E8FF", color: "#6B21A8", dotColor: "#A855F7", onClick: goToPayrollIdentities });
              // Blue: reviewing training material is a content task, not an
              // operational warning — orange is spoken for by the queues that
              // block someone from being paid or doing their job.
              if (scopeIsSuper && guideApprovalCount > 0) alerts.push({ label: "Guides awaiting approval", count: guideApprovalCount, bg: "#DBEAFE", color: "#1E3A8A", dotColor: "#3B82F6", onClick: goToGuideApprovals });
              if (scopeIsAdmin && unapprovedHoursCount > 0) alerts.push({ label: "Job hours awaiting review", count: unapprovedHoursCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToUnapprovedHours });
              if (scopeIsAdmin && unclaimedCount > 0) alerts.push({ label: "Unclaimed", count: unclaimedCount, bg: "#FEF9C3", color: "#713F12", dotColor: "#FACC15", onClick: goToUnclaimed });
              // Announcements are worker-visible — gate on scopeIsWorker
              // so acting as a client hides them, but they surface for
              // worker/admin/super scopes.
              if (scopeIsWorker && announcementCount > 0) alerts.push({ label: "Announcements", count: announcementCount, bg: "#EDE9FE", color: "#4C1D95", dotColor: "#6D28D9", onClick: goToAnnouncements });
              if (scopeIsAdmin && timelineUrgentCount > 0) alerts.push({ label: "Timeline", count: timelineUrgentCount, bg: "#E0E7FF", color: "#3730A3", dotColor: "#6366F1", onClick: goToTimeline });
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
                      <Box w="6px" h="6px" borderRadius="full" bg="white" />
                    ) : (
                      total
                    )}
                  </Box>
                  {alertDropdownOpen && (
                    <VStack
                      data-alert-dropdown
                      position="fixed"
                      bg="white"
                      borderWidth="1px"
                      borderColor="gray.200"
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
                          <Box w="full" h="1px" bg="gray.300" my={1} />
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
            {isSignedIn && !hasAnyRole && me?.isApproved && (
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
                    if (current.outer !== "worker" || current.inner !== "profile") {
                      pushNavHistory(current);
                    }
                    setTopTab("worker");
                    setWorkerInnerTab("profile" as any);
                  }}
                  width="28px"
                  height="28px"
                  borderRadius="full"
                  overflow="hidden"
                  bg="gray.200"
                  color="gray.700"
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
                  bg={isOffline ? (isForceOffline ? "orange.400" : "red.400") : queueCount > 0 ? "yellow.400" : "green.400"}
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
                  color="blue.600"
                  cursor="pointer"
                  _hover={{ textDecoration: "underline" }}
                >
                  Sign in
                </Text>
              </Link>
            ) : null}
          </div>
        </Box>
      </Box>
      {/* Only ask for geolocation when the signed-in user is an approved
          worker/admin/super. Also skipped entirely for pure client
          accounts — the /api/weather/* endpoints are staff-only and would
          403 in a loop; weather in the client-shell was aspirational
          rather than actually supported by the API.
          Gated behind `mounted` because WeatherBar's visibility depends on
          `weatherMode` (usePersistedState) — server renders the default
          "hidden" (returns null), client's first render reads the persisted
          value from localStorage which may not be "hidden" (returns a
          div). The mount gate defers WeatherBar to after hydration so
          server and client emit identical HTML on the first pass. */}
      {mounted && hasAnyRole && (
        <WeatherBar
          // Gate the geolocation permission prompt on splashDone so
          // the browser dialog doesn't cover the splash animation.
          // Same on .team and .pro — the flag is time-based, not
          // domain-based, so both domains benefit.
          allowGeolocation={splashDone && !!(me?.isApproved && hasAnyRole)}
          mode={weatherMode}
          onModeChange={setWeatherMode}
        />
      )}
      {/* Error banner when /api/me failed or timed out. Signed-in
          user with no profile = something is broken upstream (Neon
          cold, network hiccup). Renders a retryable banner in the
          content area so the app is never a blank green header.
          Suppressed when offline — the existing offline indicator
          (status dot + OfflineQueueDialog) already tells the user
          why nothing is loading; a red "couldn't load profile"
          banner would just add noise. */}
      {!meLoading && isSignedIn && meError && !me && !isOffline && (
        <Box mx={3} mt={3}>
          <Box
            borderWidth="1px"
            borderColor="red.300"
            bg="red.50"
            borderRadius="md"
            p={4}
          >
            <VStack align="start" gap={3}>
              <VStack align="start" gap={1}>
                <Text fontSize="sm" fontWeight="semibold" color="red.900">
                  Couldn&apos;t load your profile
                </Text>
                <Text fontSize="xs" color="red.800">
                  {meError.kind === "timeout" && `The request took longer than ${Math.round(meError.elapsedMs / 1000)}s and was aborted client-side. The server never responded.`}
                  {meError.kind === "http" && `The server returned HTTP ${meError.status}: ${meError.message}`}
                  {meError.kind === "network" && `Network error: ${meError.message}`}
                  {meError.kind === "unknown" && meError.message}
                </Text>
              </VStack>
              <Box
                bg="white"
                borderWidth="1px"
                borderColor="red.200"
                borderRadius="sm"
                p={2}
                w="full"
                fontSize="10px"
                fontFamily="mono"
                color="red.900"
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
      {!meLoading && me?.isApproved && !hasAnyRole && topTab !== "client" && <NoRoleNotice />}
      {/* Tasks page — orthogonal worklist surface. Takes over the
          BreadcrumbNav slot when open; closing returns the operator to
          the exact tab they were on (state never gets cleared). The
          role pills are intentionally hidden while Tasks is rendered so
          this reads as a distinct area of the app, not a tab. */}
      {authLoaded && (!isSignedIn || me) && tasksOpen && hasAnyRole && (
        <TasksPage
          // Pass SCOPED role flags so TasksPage only surfaces sections
          // the operator can act on from the currently-active top tab.
          // Raw isWorker/isAdmin/isSuper would leak admin/super sections
          // to a Super acting as Worker. See scopeIs* var docs above.
          isWorker={scopeIsWorker}
          isAdmin={scopeIsAdmin}
          isSuper={scopeIsSuper}
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
      {authLoaded && (!isSignedIn || me) && !tasksOpen && (
        <BreadcrumbNav
          outerTabs={navTabs}
          outerValue={topTab}
          hideOuterTab
          onOuterChange={(v: string) => {
            if (v !== topTab) pushNavHistory(getCurrentNavState());
            setTopTab(v as typeof topTab);
          }}
          innerValue={
            topTab === "client" ? clientInnerTab
            : topTab === "worker" ? workerInnerTab
            : topTab === "admin" ? adminInnerTab
            : superInnerTab
          }
          onInnerChange={(v: string, newOuter?: string) => {
            const outer = newOuter ?? topTab;
            const current = getCurrentNavState();
            if (v !== current.inner || outer !== current.outer) pushNavHistory(current);
            if (outer === "client") setClientInnerTab(v as ClientTabs);
            else if (outer === "worker") {
              setWorkerInnerTab(v as WorkerTabs);
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
            else if (outer === "admin") setAdminInnerTab(v as AdminTabs);
            else if (outer === "super") setSuperInnerTab(v as SuperTabs);
          }}
          categoryValue={topTab === "worker" ? workerCategory : topTab === "admin" ? adminCategory : topTab === "super" ? superCategory : undefined}
          onCategoryChange={(v: string) => {
            const currentCat = topTab === "worker" ? workerCategory : topTab === "admin" ? adminCategory : topTab === "super" ? superCategory : undefined;
            if (v !== currentCat) pushNavHistory(getCurrentNavState());
            if (topTab === "worker") setWorkerCategory(v);
            else if (topTab === "admin") setAdminCategory(v);
            else if (topTab === "super") setSuperCategory(v);
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
              color={canGoBack ? "blue.600" : "gray.400"}
              opacity={canGoBack ? 1 : 0.6}
              cursor={canGoBack ? "pointer" : "default"}
              _hover={canGoBack ? { color: "blue.700" } : {}}
              transition="all 0.1s"
              style={{ pointerEvents: canGoBack ? "auto" : "none" }}
            >
              <ArrowLeftCircle size={18} />
            </Box>
          }
          headerRight={
            <HStack gap={3} align="center">
              <Box
                as="button"
                aria-label="Copy link to this tab"
                title="Copy link to this tab"
                pl="1"
                pr="1"
                py={1}
                display="inline-flex"
                alignItems="center"
                color="gray.500"
                cursor="pointer"
                _hover={{ color: "blue.600" }}
                transition="color 0.1s"
                onClick={() => {
                // Build the deep-link URL for the current tab using the same
                // slug convention the resolver consumes: <outer>-<category>-<inner>
                // (with a 2-part fallback for outers that don't have categories).
                const slugify = (s: string) =>
                  (s || "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
                const outer = topTab;
                const inner =
                  outer === "client" ? clientInnerTab
                  : outer === "worker" ? workerInnerTab
                  : outer === "admin" ? adminInnerTab
                  : superInnerTab;
                const category =
                  outer === "worker" ? workerCategory
                  : outer === "admin" ? adminCategory
                  : outer === "super" ? superCategory
                  : undefined;
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
            </HStack>
          }
        />
      )}
      {/* Offline Queue Dialog */}
      <OfflineQueueDialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen} />

      {/* Global compliance-policy gate interceptor. Listens for
          `policies:required` events dispatched by lib/api.ts whenever the
          server throws POLICIES_REQUIRED, fetches the fresh required-
          policies list, and opens the sign wizard. Self-hides when no
          worker is signed in or there's nothing to sign. */}
      <PolicyGateInterceptor />

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
                      bg={isOffline ? (isForceOffline ? "orange.400" : "red.400") : queueCount > 0 ? "yellow.400" : "green.400"}
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
