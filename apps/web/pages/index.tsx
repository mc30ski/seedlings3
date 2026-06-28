"use client";
import { useEffect, useState, useCallback, useRef, ReactNode } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, Container, Dialog, HStack, Portal, Spinner, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle, ArrowLeftCircle, Link2 } from "lucide-react";
import { useOffline } from "@/src/lib/offline";
import OfflineQueueDialog from "@/src/ui/dialogs/OfflineQueueDialog";
import { apiGet } from "@/src/lib/api";
import { setCompressionDefaults } from "@/src/lib/imageRedact";
import { bizDateKey, bizToday, bizTomorrow, bizYesterday, bizAddDays, bizHour } from "@/src/lib/lib";
import { computeDatesFromPreset } from "@/src/lib/datePresets";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import Link from "next/link";
import { UserButton, useAuth, useUser } from "@clerk/clerk-react";

import UsersTab from "@/src/ui/tabs/UsersTab";
import ActivityTab from "@/src/ui/tabs/ActivityTab";
import HistoryTab from "@/src/ui/tabs/HistoryTab";
import SettingsTab from "@/src/ui/tabs/SettingsTab";
import SuperUnclaimedTab from "@/src/ui/tabs/SuperUnclaimedTab";
import OperationsTab from "@/src/ui/tabs/OperationsTab";
import WorkdaysTab from "@/src/ui/tabs/WorkdaysTab";
import AuditTab from "@/src/ui/tabs/AuditTab";
import BusinessExpensesTab from "@/src/ui/tabs/BusinessExpensesTab";
import ReconcileTab from "@/src/ui/tabs/ReconcileTab";
import SuppliesTab from "@/src/ui/tabs/SuppliesTab";
import DocumentsTab from "@/src/ui/tabs/DocumentsTab";
import TimelineTab from "@/src/ui/tabs/TimelineTab";
import WeatherBar, { WeatherIcon, type WeatherBarMode } from "@/src/ui/components/WeatherBar";
import WorkdayStrip from "@/src/ui/components/WorkdayStrip";
import EquipmentTab from "@/src/ui/tabs/EquipmentTab";
import JobsTab from "@/src/ui/tabs/JobsTab";
import ClientsTab from "@/src/ui/tabs/ClientsTab";
import PropertiesTab from "@/src/ui/tabs/PropertiesTab";
import PaymentsTab from "@/src/ui/tabs/PaymentsTab";
import ServicesTab from "@/src/ui/tabs/ServicesTab";
import AdminJobsTab from "@/src/ui/tabs/AdminJobsTab";
import ClientFeedTab from "@/src/ui/tabs/ClientFeedTab";
import ClientMyJobsTab from "@/src/ui/tabs/ClientMyJobsTab";
import ClientServicesTab from "@/src/ui/tabs/ClientServicesTab";
import RemindersTab from "@/src/ui/tabs/RemindersTab";
import AdminRemindersTab from "@/src/ui/tabs/AdminRemindersTab";
import AdminHomeTab from "@/src/ui/tabs/AdminHomeTab";
import PlanWorkdayWorkflow from "@/src/ui/workflows/PlanWorkdayWorkflow";
import BeginWorkDayWorkflow from "@/src/ui/workflows/BeginWorkDayWorkflow";
import AdminTasksTab, { type TaskDef, FiPlus, FiDownload, FiDatabase, FiShare2 } from "@/src/ui/tabs/AdminTasksTab";
import SharePhotosWorkflow from "@/src/ui/workflows/SharePhotosWorkflow";
// StatisticsTab is no longer wired into the worker or super shell (both tab
// entries were removed per operator preference). The component file and the
// /api/me/statistics + /api/admin/statistics endpoints stay in place so
// the import can be reinstated cleanly if the tab returns.
// import StatisticsTab from "@/src/ui/tabs/StatisticsTab";
import ProfileTab from "@/src/ui/tabs/ProfileTab";
import AdminRoutesTab from "@/src/ui/tabs/AdminRoutesTab";
import PreviewRoutesTab from "@/src/ui/tabs/PreviewRoutesTab";
import HomeTab from "@/src/ui/tabs/HomeTab";
import ImpersonationBanner from "@/src/ui/components/ImpersonationBanner";
import MulchJobTool from "@/src/ui/tools/MulchJobTool";
import MowingJobTool from "@/src/ui/tools/MowingJobTool";
import AdminNotifyTab from "@/src/ui/tabs/AdminNotifyTab";
import AdminCollectionsTab from "@/src/ui/tabs/AdminCollectionsTab";
import WorkerCollectionsTab from "@/src/ui/tabs/WorkerCollectionsTab";
import EquipmentUsageTab from "@/src/ui/tabs/EquipmentUsageTab";
import AdminGroupsTab from "@/src/ui/tabs/AdminGroupsTab";
import PricingTab from "@/src/ui/tabs/PricingTab";

import AppSplash from "@/src/ui/helpers/AppSplash";
import AwaitingApprovalNotice from "@/src/ui/notices/AwaitingApprovalNotice";
import NoRoleNotice from "@/src/ui/notices/NoRoleNotice";

import InlineMessage, { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import NewJobSetupWorkflow from "@/src/ui/components/NewJobSetupWorkflow";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

import { Me, Role, AdminTabs, ClientTabs, WorkerTabs, SuperTabs, EventTypes } from "@/src/lib/types";
import {
  FiBriefcase,
  FiClipboard,
  FiTool,
  FiPackage,
  FiUser,
  FiUsers,
  FiFileText,
  FiMapPin,
  FiActivity,
  FiHome,
  FiBarChart2,
  FiBell,
  FiNavigation,
  FiSettings,
  FiShield,
  FiAlertCircle,
  FiSun,
  FiSearch,
  FiFolder,
  FiCalendar,
  FiBook,
  FiClock,
  FiTag,
  FiRefreshCw,
} from "react-icons/fi";
import { GrUserAdmin } from "react-icons/gr";
import { AiOutlineTeam } from "react-icons/ai";
import { TfiMoney } from "react-icons/tfi";

import ScrollableUnderlineTabs, {
  TabItem,
} from "../src/ui/components/ScrollableUnderlineTabs";
import BreadcrumbNav from "@/src/ui/components/BreadcrumbNav";

const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

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
  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isWorker = hasRole(me?.roles, "WORKER");
  const isSuper = hasRole(me?.roles, "SUPER");
  const hasAnyRole = (me?.roles?.length ?? 0) > 0;

  const [topTab, setTopTab] = usePersistedState<"client" | "worker" | "admin" | "super">("topTab", "client");

  const [clientInnerTab, setClientInnerTab] = usePersistedState<ClientTabs>("clientTab", "public");
  const [adminInnerTab, setAdminInnerTab] = usePersistedState<AdminTabs>("adminTab", "admin-jobs");
  const [workerInnerTab, setWorkerInnerTab] = usePersistedState<WorkerTabs>("workerTab", "reminders");
  const [workerCategory, setWorkerCategory] = usePersistedState<string>("workerCategory", "Work");
  const [adminCategory, setAdminCategory] = usePersistedState<string>("adminCategory", "Work");
  const [superCategory, setSuperCategory] = usePersistedState<string>("superCategory", "Records");
  const [superInnerTab, setSuperInnerTab] = usePersistedState<SuperTabs>("superTab", "operations");

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
  const [workdaysJumpDate, setWorkdaysJumpDate] = useState<string | null>(null);
  const [workdaysJumpNonce, setWorkdaysJumpNonce] = useState(0);
  const loadPendingWorkdaysRef = useRef<() => Promise<void>>(async () => {});
  // Super-only: count of open ledger followups (Money → Ledger flags
  // waiting on the operator). Drives the "Ledger followups" entry in the
  // alerts dropdown and pre-applies the "Followups only" filter on click.
  const [ledgerFollowupCount, setLedgerFollowupCount] = useState<number>(0);

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
  // Admin-side remount counters — used by AdminHomeTab (which impersonates a worker)
  // when its tile click-throughs route into admin tabs that need to re-read fresh
  // localStorage filters.
  const [adminJobsRemountKey, setAdminJobsRemountKey] = useState(0);
  const [adminEquipmentRemountKey, setAdminEquipmentRemountKey] = useState(0);
  const [adminPaymentsRemountKey, setAdminPaymentsRemountKey] = useState(0);
  const [adminRemindersRemountKey, setAdminRemindersRemountKey] = useState(0);

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

  function restoreFromHistory() {
    const h = navHistoryRef.current;
    if (h.length === 0) return;
    const prev = h.pop()!;
    setCanGoBack(h.length > 0);
    // Update refs immediately so the next pushNavHistory reads the restored state
    topTabRef.current = prev.outer as any;
    if (prev.outer === "client") clientInnerTabRef.current = prev.inner as any;
    else if (prev.outer === "worker") { workerInnerTabRef.current = prev.inner as any; if (prev.category) workerCategoryRef.current = prev.category; }
    else if (prev.outer === "admin") { adminInnerTabRef.current = prev.inner as any; if (prev.category) adminCategoryRef.current = prev.category; }
    else if (prev.outer === "super") { superInnerTabRef.current = prev.inner as any; if (prev.category) superCategoryRef.current = prev.category; }
    else if (prev.outer === "super") superInnerTabRef.current = prev.inner as any;
    // Now set React state (no skipNextPush needed — onOuterChange/onInnerChange only fire from user clicks)
    setTopTab(prev.outer as any);
    if (prev.outer === "client") setClientInnerTab(prev.inner as any);
    else if (prev.outer === "worker") { setWorkerInnerTab(prev.inner as any); if (prev.category) setWorkerCategory(prev.category); }
    else if (prev.outer === "admin") { setAdminInnerTab(prev.inner as any); if (prev.category) setAdminCategory(prev.category); }
    else if (prev.outer === "super") { setSuperInnerTab(prev.inner as any); if (prev.category) setSuperCategory(prev.category); }
    else if (prev.outer === "super") setSuperInnerTab(prev.inner as any);
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
  useEffect(() => {
    const check = () => {
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
      onClick: () => setActiveWorkflow("new-job-setup"),
    },
    {
      id: "share-photos",
      label: "Share Photos",
      description: "Select photos from jobs and share to Instagram, social media, or download",
      icon: FiShare2,
      colorPalette: "orange",
      bgColor: "orange.50",
      onClick: () => setActiveWorkflow("share-photos"),
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

  const loadMe = useCallback(async () => {
    setMeLoading(true);
    try {
      const data = await apiGet<Me>("/api/me");
      setMe(data);
    } catch {
      setMe(null);
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
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
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
  }, [authLoaded, isSignedIn]);

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

  // When a signed-in approved client lands on the prior default tab
  // ("public" / Community), flip them to "My Properties" — the
  // personalized view is the more useful landing target. Honors any
  // explicit later navigation: switching to Community manually persists
  // and won't be bounced back the next session (the redirect only fires
  // when the user's stored choice is still "public").
  const clientDefaultFlippedRef = useRef(false);
  useEffect(() => {
    if (!me?.isApproved) return;
    if (isWorker || isAdmin) return;
    if (topTab !== "client") return;
    if (clientInnerTab !== "public") return;
    if (clientDefaultFlippedRef.current) return;
    clientDefaultFlippedRef.current = true;
    setClientInnerTab("my-jobs");
  }, [me?.isApproved, isWorker, isAdmin, topTab, clientInnerTab, setClientInnerTab]);

  // Re-fetch me silently when switching top tabs so admin changes are reflected
  useEffect(() => {
    if (!meLoading) void refreshMe();
  }, [topTab]);

  function wrapWithInlineMessage(tab: ReactNode) {
    return (
      <>
        <InlineMessage />
        {tab}
      </>
    );
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
      value: "public",
      label: "Community",
      icon: FiActivity,
      content: <ClientFeedTab />,
    },
    {
      value: "services",
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
            onConfirm: () => setActiveWorkflow("plan-workday-trainee"),
          });
        } else {
          setActiveWorkflow("plan-workday");
        }
      },
    },
    {
      id: "start-day",
      label: "Begin Work Day",
      description: "Review today's schedule, confirm jobs, and start your first stop",
      icon: FiSun,
      colorPalette: "green",
      bgColor: "green.50",
      onClick: () => {
        setActiveWorkflow("begin-workday");
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
      content: wrapWithInlineMessage(<HomeTab me={me} onLaunchWorkflow={(name) => setActiveWorkflow(name)} />),
    },
    {
      value: "reminders",
      label: "Planning",
      icon: FiBell,
      content: wrapWithInlineMessage(<><WorkdayStrip /><RemindersTab myId={me?.id} me={me} /></>),
    },
    {
      value: "jobs",
      label: "Jobs",
      icon: FiClipboard,
      content: wrapWithInlineMessage(<JobsTab key={`wjobs-${jobsRemountKey}`} me={me} purpose="WORKER" />),
    },
    {
      value: "routes",
      label: "Routes",
      icon: FiNavigation,
      visible: () => !!me?.workerType,
      content: wrapWithInlineMessage(<><WorkdayStrip /><PreviewRoutesTab /></>),
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
      content: wrapWithInlineMessage(<EquipmentTab key={`weq-${equipmentRemountKey}`} me={me} purpose="WORKER" />),
    },
    {
      value: "collections",
      label: "Collections",
      icon: FiPackage,
      content: wrapWithInlineMessage(<WorkerCollectionsTab />),
    },
    {
      value: "usage",
      label: "Usage",
      icon: FiBarChart2,
      content: wrapWithInlineMessage(<EquipmentUsageTab purpose="WORKER" />),
    },
    // ── Directory ──
    {
      value: "clients",
      label: "Clients",
      icon: FiUsers,
      content: wrapWithInlineMessage(<ClientsTab me={me} purpose="WORKER" />),
    },
    {
      value: "properties",
      label: "Properties",
      icon: FiMapPin,
      content: wrapWithInlineMessage(
        <PropertiesTab me={me} purpose="WORKER" />
      ),
    },
    // ── Money ──
    {
      value: "payments",
      label: "Payments",
      icon: TfiMoney,
      content: wrapWithInlineMessage(<PaymentsTab key={`wpay-${paymentsRemountKey}`} me={me} purpose="WORKER" />),
    },
    {
      value: "pricing",
      label: "Pricing",
      icon: FiTag,
      content: wrapWithInlineMessage(<PricingTab readOnly />),
    },
    {
      value: "supplies",
      label: "Supplies",
      icon: FiPackage,
      content: wrapWithInlineMessage(<SuppliesTab readOnly purpose="WORKER" />),
    },
    // NOTE: the Worker "Records → Statistics" tab was removed per operator
    // preference (no longer needed). The StatisticsTab component file and
    // its API endpoints (/api/me/statistics, /api/admin/statistics) stay
    // in place in case the tab is wanted back later — to restore, re-add a
    // tab block here with visible: () => !!me?.workerType and
    // content: <StatisticsTab myId={me?.id} />, plus the catMap entry
    // `statistics: "Records"` below.
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
      // ── Records ──
      // Moved to the top of the Admin shell per operator preference, mirroring
      // the Super shell ordering. BreadcrumbNav derives the category list
      // from the order tabs appear here; keep tabs of the same category
      // contiguous.
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
      // ── Work ──
      // Inner value matches the Worker shell's Home tab so BreadcrumbNav's
      // cross-role jump chip pairs them — one tap in the inner dropdown
      // takes Admin → Worker Home and vice versa.
      value: "home",
      label: "Home",
      icon: FiHome,
      content: wrapWithInlineMessage(<AdminHomeTab me={me} />),
    },
    {
      value: "reminders",
      label: "Planning",
      icon: FiBell,
      content: wrapWithInlineMessage(<AdminRemindersTab key={`arem-${adminRemindersRemountKey}`} me={me} />),
    },
    {
      value: "admin-jobs",
      label: "Jobs",
      icon: FiClipboard,
      content: wrapWithInlineMessage(<AdminJobsTab key={`ajobs-${adminJobsRemountKey}`} me={me} purpose="ADMIN" />),
    },
    {
      value: "routes",
      label: "Routes",
      icon: FiNavigation,
      content: wrapWithInlineMessage(<AdminRoutesTab />),
    },
    {
      value: "jobs",
      label: "Services",
      icon: FiBriefcase,
      content: wrapWithInlineMessage(<ServicesTab me={me} purpose="ADMIN" />),
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
      content: wrapWithInlineMessage(<EquipmentTab key={`aeq-${adminEquipmentRemountKey}`} me={me} purpose="ADMIN" />),
    },
    {
      value: "collections",
      label: "Collections",
      icon: FiPackage,
      content: wrapWithInlineMessage(<AdminCollectionsTab />),
    },
    {
      value: "usage",
      label: "Usage",
      icon: FiBarChart2,
      content: wrapWithInlineMessage(<EquipmentUsageTab purpose="ADMIN" />),
    },
    {
      // ── Directory ──
      value: "clients",
      label: "Clients",
      icon: FiUsers,
      content: wrapWithInlineMessage(<ClientsTab me={me} purpose="ADMIN" />),
    },
    {
      value: "properties",
      label: "Properties",
      icon: FiMapPin,
      content: wrapWithInlineMessage(<PropertiesTab me={me} purpose="ADMIN" />),
    },
    {
      value: "users",
      label: "Users",
      icon: AiOutlineTeam,
      // Read-only for admins. User management (approve / role changes /
      // privilege toggles / delete) moved to the Super tab. Admins see
      // the directory for context but can't mutate it, and pending
      // users are hidden entirely so the queue doesn't tempt action.
      content: wrapWithInlineMessage(<UsersTab role="admin" readOnly />),
    },
    {
      value: "groups",
      label: "Groups",
      icon: AiOutlineTeam,
      content: wrapWithInlineMessage(<AdminGroupsTab />),
    },
    {
      // ── Money ──
      value: "payments",
      label: "Payments",
      icon: TfiMoney,
      content: wrapWithInlineMessage(<PaymentsTab key={`apay-${adminPaymentsRemountKey}`} me={me} purpose="ADMIN" />),
    },
    {
      value: "pricing",
      label: "Pricing",
      icon: FiTag,
      content: wrapWithInlineMessage(<PricingTab readOnly />),
    },
    {
      value: "supplies",
      label: "Supplies",
      icon: FiPackage,
      content: wrapWithInlineMessage(<SuppliesTab readOnly purpose="ADMIN" />),
    },
    {
      // ── System ──
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
    {
      value: "profile",
      label: "Profile",
      icon: FiUser,
      content: wrapWithInlineMessage(<ProfileTab me={me} isAdmin purpose="ADMIN" onProfileUpdated={refreshMe} />),
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
          {me?.workerType === "CONTRACTOR" && !me.isInsuranceValid && (
            <Box mb={2} p={3} bg="red.50" borderWidth="1px" borderColor="red.300" rounded="md">
              <HStack gap={2} align="start">
                <Box flexShrink={0} pt="0.5"><AlertTriangle size={14} color="var(--chakra-colors-red-500)" /></Box>
                <Text fontSize="sm" color="red.700">
                  {me.hasInsuranceCert ? "Your insurance certificate has expired." : "No insurance certificate on file."}
                  {" "}Some jobs and equipment may be restricted until this is resolved.
                </Text>
              </HStack>
            </Box>
          )}
          <PlanWorkdayWorkflow
            active={activeWorkflow === "plan-workday" || activeWorkflow === "plan-workday-trainee"}
            onDone={() => setActiveWorkflow(null)}
            myId={me?.id}
            trainee={activeWorkflow === "plan-workday-trainee"}
          />
          <BeginWorkDayWorkflow
            active={activeWorkflow === "begin-workday"}
            onDone={() => setActiveWorkflow(null)}
            myId={me?.id}
            myWorkerType={me?.workerType ?? null}
          />
          {pausedWorkflow && workerInnerTab !== "tasks" && (
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
                  ? "You're in the Begin Work Day workflow. Return when you're done here."
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
                  window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "tasks" } }));
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
          home: "Work", reminders: "Work", jobs: "Work", routes: "Work", tasks: "Work",
          equipment: "Equipment", collections: "Equipment", usage: "Equipment",
          clients: "Directory", properties: "Directory",
          payments: "Money", pricing: "Money", supplies: "Money",
          // statistics: "Records" — re-add when the Worker Statistics tab is restored.
          profile: "System",
        };
        const catIconMap: Record<string, React.ElementType> = {
          Work: FiClipboard, Equipment: FiTool, Directory: FiUsers, Money: TfiMoney, Records: FiBarChart2, System: FiSettings,
        };
        return workerTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content, category: catMap[t.value], categoryIcon: catIconMap[catMap[t.value]], chip: t.value === "tasks" }));
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
                setAdminInnerTab("jobs" as any);
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
          home: "Work", reminders: "Work", "admin-jobs": "Work", routes: "Work", jobs: "Work", tasks: "Work",
          equipment: "Equipment", collections: "Equipment", usage: "Equipment",
          clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
          payments: "Money", pricing: "Money", supplies: "Money",
          activity: "Records", history: "Records", timeline: "Records", documents: "Records",
          notify: "System", settings: "System", profile: "System",
        };
        const catIconMap: Record<string, React.ElementType> = {
          Work: FiClipboard, Equipment: FiTool, Directory: FiUsers, Money: TfiMoney, Records: FiBarChart2, System: FiSettings,
        };
        return adminTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content, category: catMap[t.value], categoryIcon: catIconMap[catMap[t.value]], chip: t.value === "tasks" }));
      })(),
    },
    {
      value: "super",
      label: "Super",
      icon: FiShield,
      visible: () => !!isSignedIn && isSuper,
      innerTabs: [
        {
          // ── Records ──
          // Moved to the top of the Super shell per operator preference —
          // the day-to-day "what's happening" tabs (Operations + Audit +
          // Timeline + Documents) are now the first thing a Super sees on
          // the inner tab rail. Category order otherwise matches the
          // intended display order, see comment above the workerTabs map.
          value: "operations",
          label: "Operations",
          icon: FiBarChart2,
          content: <OperationsTab />,
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
          // Reconcile — accounting-software validation surface. Replaces
          // the old Exports + P&L Report tabs. Renders a QB-style P&L
          // for the selected window with click-to-drill-down on every
          // row, and offers flat CSVs (Capital, Income, Expenses,
          // Workdays) for visual cross-checking against the operator's
          // accounting software (which is now the source of truth, wired
          // directly to the bank). See ReconcileTab.tsx + services/
          // pnlReport.ts + services/exports.ts.
          //
          // Lives under Records (not Money) because it's primarily a
          // review / audit surface for reconciling against an external
          // system, alongside Workdays / Audit / Timeline.
          value: "reconcile",
          label: "Reconcile",
          icon: FiBarChart2,
          content: wrapWithInlineMessage(<ReconcileTab />),
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
          // ── Equipment ──
          // Same component as the admin Inventory tab, but rendered with
          // purpose="SUPER" so EquipmentTab exposes its act-on-behalf-of-
          // worker controls (reserve / cancel / checkout / return for a
          // specific worker). Fail-safe for when a worker is stuck in the
          // mobile flow and a Super needs to drive the action remotely.
          value: "equipment",
          label: "Inventory",
          icon: FiTool,
          content: wrapWithInlineMessage(<EquipmentTab key={`seq-${adminEquipmentRemountKey}`} me={me} purpose="SUPER" />),
          category: "Equipment",
          categoryIcon: FiTool,
        },
        {
          // ── Directory ──
          // Super-only writable Users view. The same component admins
          // see read-only on their Directory tab, but with full mutation
          // surface (approve / role changes / privilege toggles / delete).
          // The "Pending Users" alert chip in the title bar routes here.
          value: "users",
          label: "Users",
          icon: AiOutlineTeam,
          content: wrapWithInlineMessage(<UsersTab role="admin" />),
          category: "Directory",
          categoryIcon: AiOutlineTeam,
        },
        {
          // ── Money ──
          value: "payments",
          label: "Payments",
          icon: TfiMoney,
          content: wrapWithInlineMessage(<PaymentsTab me={me} purpose="SUPER" />),
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
          value: "ledger",
          label: "Ledger",
          icon: FiBook,
          content: wrapWithInlineMessage(<BusinessExpensesTab />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        // NOTE: Reconcile moved out of Money → Records. It lives next to
        // Workdays / Audit / Timeline now since it's an external-system
        // reconciliation surface rather than a per-record money editor.
        // NOTE: the Super "Money → Statistics" tab was removed per operator
        // preference (no longer needed for routine ops review). The
        // StatisticsTab component still ships for the Worker personal-stats
        // view (workerTabs, "Records" category). To restore the Super entry,
        // re-add a tab block here pointing at <StatisticsTab /> (no myId).
        {
          value: "supplies",
          label: "Supplies",
          icon: FiPackage,
          content: wrapWithInlineMessage(<SuppliesTab />),
          category: "Money",
          categoryIcon: TfiMoney,
        },
        {
          value: "pricing",
          label: "Pricing",
          icon: FiTag,
          content: wrapWithInlineMessage(<PricingTab isSuper />),
          category: "Money",
          categoryIcon: TfiMoney,
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
          // ── System ──
          value: "settings",
          label: "Settings",
          icon: FiSettings,
          content: wrapWithInlineMessage(<SettingsTab me={me} purpose="SUPER" />),
          category: "System",
          categoryIcon: FiSettings,
        },
        {
          value: "profile",
          label: "Profile",
          icon: FiUser,
          content: wrapWithInlineMessage(<ProfileTab me={me} isAdmin purpose="SUPER" onProfileUpdated={refreshMe} />),
          category: "System",
          categoryIcon: FiSettings,
        },
      ],
    },
  ];

  const setupSearchEvent = (
    eventName: EventTypes,
    tabName: AdminTabs & WorkerTabs
  ) => {
    useEffect(() => {
      if (typeof window === "undefined") return;
      const onEvent = (e: Event) => {
        const { q, forAdmin, entityId } = (e as CustomEvent).detail || {};
        if (!q && !entityId) return;
        pushNavHistory(getCurrentNavState());
        setTopTab(forAdmin ? "admin" : "worker");
        forAdmin ? setAdminInnerTab(tabName) : setWorkerInnerTab(tabName);
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
  // paymentsTabToServicesTabSearch (legacy name — actually routes to the
  // proper JOBS tab now, not Services). Admin lands on AdminJobsTab, worker
  // on JobsTab. The destination filters by jobId via the dedicated
  // `jobsTab:filterJob` event below so the result is exact (vs. a loose
  // property-name search which can land on the wrong job when multiple
  // jobs share a property).
  setupSearchEvent("jobsTabToServicesTabSearch", "jobs");

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
        setAdminInnerTab("admin-jobs");
      } else {
        setTopTab("worker");
        setWorkerInnerTab("jobs");
      }
      window.sessionStorage.setItem(
        "paymentsTabToJobsNav",
        JSON.stringify({ occId: entityId, anchorAt: anchorAt ?? null }),
      );
    };
    window.addEventListener("open:paymentsTabToServicesTabSearch", onEvent as EventListener);
    return () => window.removeEventListener("open:paymentsTabToServicesTabSearch", onEvent as EventListener);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onAdminJobs = topTab === "admin" && adminInnerTab === "admin-jobs";
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

  // Services → Admin Jobs (special: targets "admin-jobs" inner tab)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onEvent = (e: Event) => {
      const { entityId } = (e as CustomEvent).detail || {};
      if (!entityId) return;
      setTopTab("admin");
      setAdminInnerTab("admin-jobs");
      window.sessionStorage.setItem("servicesTabToJobsNav", entityId);
    };
    window.addEventListener("open:servicesTabToJobsTabSearch", onEvent as EventListener);
    return () => window.removeEventListener("open:servicesTabToJobsTabSearch", onEvent as EventListener);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (adminInnerTab !== "admin-jobs") return;
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

  // Reminders → Jobs: admin goes to admin-jobs, worker goes to jobs
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onEvent = (e: Event) => {
      const { q, forAdmin, entityId } = (e as CustomEvent).detail || {};
      if (!q && !entityId) return;
      if (forAdmin) {
        setTopTab("admin");
        setAdminInnerTab("admin-jobs");
      } else {
        setTopTab("worker");
        setWorkerInnerTab("jobs");
      }
      window.sessionStorage.setItem(
        "open:remindersToJobsTabSearchOnce",
        JSON.stringify({ q: q || "", entityId }),
      );
    };
    window.addEventListener("open:remindersToJobsTabSearch", onEvent as EventListener);
    return () => window.removeEventListener("open:remindersToJobsTabSearch", onEvent as EventListener);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "open:remindersToJobsTabSearchOnce";
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    let payload: { q: string; entityId?: string };
    try { payload = JSON.parse(raw); } catch { payload = { q: raw }; }
    window.sessionStorage.removeItem(key);
    const timer = setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("remindersToJobsTabSearch:run", { detail: payload })
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [topTab, adminInnerTab, workerInnerTab]);

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
  useEffect(() => {
    function onWeather(e: any) {
      const d = e?.detail;
      if (d && typeof d.temp === "number" && typeof d.icon === "string") {
        setTitleWeather({ temp: d.temp, icon: d.icon });
      }
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
  }, [isSignedIn, me?.id]);
  function fmtEarnings(n: number): string {
    if (n >= 100000) return `${Math.round(n / 1000)}k`;
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function cycleEarningsPeriod() {
    const idx = EARNINGS_PERIODS.indexOf(earningsPeriod);
    setEarningsPeriod(EARNINGS_PERIODS[(idx + 1) % EARNINGS_PERIODS.length]);
  }

  const headerBtnRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

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
      markAlertLoaded("pendingWorkdays");
      return;
    }
    try {
      const r = await apiGet<{
        totalPending: number;
        byDate: { workdayDate: string; count: number }[];
      }>("/api/super/workdays/pending-summary");
      setPendingWorkdays(r?.totalPending ?? 0);
      setPendingWorkdaysByDate(Array.isArray(r?.byDate) ? r.byDate : []);
    } catch {
      setPendingWorkdays(0);
      setPendingWorkdaysByDate([]);
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

  // Guaranteed-payout summary (super-only). `active` = currently in an
  // open period; `expiringSoon` = active AND ≤ 7 days from expiration —
  // the bucket the title-bar alert chip surfaces so an operator gets a
  // proactive nudge to decide renew-or-let-expire before the natural
  // transition. Doesn't fire until super is logged in (route is super-
  // gated). The active count surfaces inside the Users tab; this state
  // exists in the shell only because the alert chip lives in the shell.
  const [guaranteedPayoutActiveCount, setGuaranteedPayoutActiveCount] = useState<number>(0);
  const [guaranteedPayoutExpiringCount, setGuaranteedPayoutExpiringCount] = useState<number>(0);
  const loadGuaranteedPayoutSummary = useCallback(async () => {
    if (!isSuper) {
      setGuaranteedPayoutActiveCount(0);
      setGuaranteedPayoutExpiringCount(0);
      markAlertLoaded("guaranteedPayout");
      return;
    }
    try {
      const res = await apiGet<{ active: number; expiringSoon: number }>(
        "/api/admin/users/guaranteed-payout-summary",
      );
      setGuaranteedPayoutActiveCount(res?.active ?? 0);
      setGuaranteedPayoutExpiringCount(res?.expiringSoon ?? 0);
    } catch {
      setGuaranteedPayoutActiveCount(0);
      setGuaranteedPayoutExpiringCount(0);
    }
    markAlertLoaded("guaranteedPayout");
  }, [isSuper]);

  useEffect(() => {
    void loadGuaranteedPayoutSummary();
  }, [loadGuaranteedPayoutSummary]);

  // Overdue count for admin header badge — matches Admin Jobs tab overdue logic
  const [overdueCount, setOverdueCount] = useState(0);
  const loadOverdue = useCallback(async () => {
    if (!isAdmin) { setOverdueCount(0); markAlertLoaded("overdue"); return; }
    try {
      const today = bizToday();
      const toStr = bizYesterday();
      const fromStr = bizAddDays(today, -60);
      const list = await apiGet<any[]>(`/api/occurrences?from=${fromStr}&to=${toStr}`);
      const excludeStatuses = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      // Match JobsTab's overdue filter — announcements are not "overdue" work
      const count = (Array.isArray(list) ? list : []).filter(
        (o) => o.workflow !== "ANNOUNCEMENT" &&
          o.startAt && !excludeStatuses.has(o.status) &&
          bizDateKey(o.startAt) < today &&
          bizDateKey(o.startAt) >= fromStr
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

  // Navigate to admin Jobs tab filtered to unapproved-hours occurrences.
  // Same handoff pattern as overdue / estimate-followups: localStorage flag
  // for mount-time pickup + dispatched event for already-mounted case.
  const goToUnapprovedHours = useCallback(() => {
    try {
      localStorage.setItem("seedlings_adminJobs_showUnapprovedHours", "1");
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    setTopTab("admin");
    setAdminInnerTab("admin-jobs");
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showUnapprovedHours"));
    }, 100);
  }, []);

  // Navigate to admin Jobs tab with the estimate-followup filter applied.
  // Mirrors goToOverdue / goToUnclaimed: writes a flag to localStorage so
  // the tab picks it up on mount, then fires an event in case it's already
  // mounted.
  const goToEstimateFollowups = useCallback(() => {
    try {
      localStorage.setItem("seedlings_adminJobs_showEstimateFollowups", "1");
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    setTopTab("admin");
    setAdminInnerTab("admin-jobs");
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showEstimateFollowups"));
    }, 100);
  }, []);

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
  const alertsReady = !!(alertsLoaded.pending && alertsLoaded.overdue && alertsLoaded.unclaimed && alertsLoaded.announcements && alertsLoaded.planning && alertsLoaded.pendingPayments && alertsLoaded.awaitingClientPayment && alertsLoaded.changeRequests && alertsLoaded.estimateFollowups && alertsLoaded.unapprovedHours && alertsLoaded.guaranteedPayout && alertsLoaded.pendingWorkdays && alertsLoaded.ledgerFollowups);
  const markAlertLoaded = useCallback((key: string) => setAlertsLoaded((prev) => prev[key] ? prev : { ...prev, [key]: true }), []);
  const loadAnnouncementCount = useCallback(async () => {
    if (!me?.isApproved) { setAnnouncementCount(0); if (me) markAlertLoaded("announcements"); return; }
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
  }, [me?.isApproved]);

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
    setTopTab("admin");
    setAdminInnerTab("admin-jobs");
    // Signal the Jobs tab to apply unclaimed filter
    try { localStorage.setItem("seedlings_adminJobs_showUnclaimed", "1"); } catch {}
    // Also dispatch event in case the tab is already mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showUnclaimed"));
    }, 50);
  }, []);

  const goToOverdue = useCallback(() => {
    try {
      localStorage.setItem("seedlings_adminJobs_showOverdue", "1");
      // Clear the "View as" user filter so all overdue jobs are shown
      localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    } catch {}
    setTopTab("admin");
    setAdminInnerTab("admin-jobs");
    // Also dispatch event for when component is already mounted
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("adminJobs:showOverdue"));
    }, 100);
  }, []);

  // Jump to the admin Jobs tab and scroll to the Client Requests section.
  // The section is mounted at the top of the Jobs view for admins, so we
  // navigate there and then scroll-into-view its anchor.
  const goToClientRequests = useCallback(() => {
    setTopTab("admin");
    setAdminInnerTab("admin-jobs");
    setTimeout(() => {
      const el = document.getElementById("client-requests-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }, []);

  // Planning badge count — items on the worker's Planning tab that haven't been dismissed
  const [planningCount, setPlanningCount] = useState(0);
  // Single dashboard summary replaces multiple separate API calls for badge counts
  const loadDashboardSummary = useCallback(async () => {
    if (!me?.id) { setPlanningCount(0); if (me) markAlertLoaded("planning"); return; }
    try {
      const list = await apiGet<any[]>("/api/occurrences");
      if (!Array.isArray(list)) { setPlanningCount(0); markAlertLoaded("planning"); return; }

      const myId = me.id;
      const myItems = list
        .filter((occ: any) => !occ._isReminderGhost && !occ._isPinnedGhost)
        .filter((occ: any) => (occ.assignees ?? []).some((a: any) => a.userId === myId));

      const tomorrowKey = bizTomorrow();

      // Count tomorrow's items that need client confirmation
      const tomorrowNeedsConfirm = myItems.filter((occ: any) =>
        (occ.status === "SCHEDULED" || occ.status === "ACCEPTED") &&
        occ.startAt && bizDateKey(occ.startAt) === tomorrowKey &&
        occ.workflow !== "ANNOUNCEMENT" &&
        occ.workflow !== "EVENT" &&
        occ.jobId && !occ.isClientConfirmed
      ).length;

      setPlanningCount(tomorrowNeedsConfirm);
    } catch {
      setPlanningCount(0);
    }
    markAlertLoaded("planning");
  }, [me?.id]);

  useEffect(() => {
    void loadDashboardSummary();
    const onRefresh = () => void loadDashboardSummary();
    // Refresh on data changes
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    window.addEventListener("seedlings3:planning-changed", onRefresh);
    // Refresh when app becomes visible (day change, phone wake, tab switch)
    const onVisible = () => { if (document.visibilityState === "visible") void loadDashboardSummary(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("seedlings3:jobs-changed", onRefresh);
      window.removeEventListener("seedlings3:planning-changed", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadDashboardSummary]);

  const goToPlanning = useCallback(() => {
    setTopTab("worker");
    setWorkerInnerTab("reminders" as any);
  }, []);

  // Timeline alert — merged count of urgent timeline events + expiring
  // documents (urgent = past or ≤7 days). Super uses /super/ for the full
  // view including hidden items; admin uses /admin/ which filters hidden
  // server-side.
  const [timelineUrgentCount, setTimelineUrgentCount] = useState(0);
  const loadTimelineCount = useCallback(async () => {
    if (!isAdmin) { setTimelineUrgentCount(0); if (me) markAlertLoaded("timeline"); return; }
    try {
      const endpoint = isSuper
        ? "/api/super/timeline/upcoming-counts"
        : "/api/admin/timeline/upcoming-counts";
      const r = await apiGet<{ urgent: number; soon: number }>(endpoint);
      setTimelineUrgentCount(r?.urgent ?? 0);
    } catch {
      setTimelineUrgentCount(0);
    }
    markAlertLoaded("timeline");
  }, [isAdmin, isSuper, me]);

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
        loadDashboardSummary(),
        loadTimelineCount(),
        loadLedgerFollowupCount(),
      ]);
    } finally {
      setAlertsRefreshing(false);
    }
  }, [
    loadPending, loadPendingPayments, loadPendingWorkdays, loadAwaitingClientPayment,
    loadOverdue, loadChangeRequestCount, loadEstimateFollowupCount,
    loadUnapprovedHoursCount, loadUnclaimed, loadAnnouncementCount,
    loadDashboardSummary, loadTimelineCount, loadLedgerFollowupCount,
  ]);

  const goToTimeline = useCallback(() => {
    try { sessionStorage.setItem("pendingTimelineUrgencyFilter", "urgent"); } catch {}
    if (isSuper) {
      setTopTab("super");
      setSuperInnerTab("timeline" as any);
      setSuperCategory("Records");
    } else if (isAdmin) {
      setTopTab("admin");
      setAdminInnerTab("timeline" as any);
      setAdminCategory("Records");
    }
  }, [isSuper, isAdmin]);

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

      setTopTab("admin");
      setAdminInnerTab("users");

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

  // Mirror handler for admin tab navigation. Used by AdminHomeTab's tile click-throughs
  // (which target admin tabs filtered to the impersonated worker). Same remount-on-demand
  // pattern as the worker version — caller pre-writes localStorage, we bump the key.
  // Also updates adminCategory when the destination tab lives in a different category
  // than the current one — otherwise the category nav stays on the old category and
  // the inner-tab bar can render the wrong set of tabs.
  useEffect(() => {
    const adminCatMap: Record<string, string> = {
      home: "Work", reminders: "Work", "admin-jobs": "Work", routes: "Work", jobs: "Work", tasks: "Work",
      equipment: "Equipment", collections: "Equipment", usage: "Equipment",
      clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
      payments: "Money", pricing: "Money", supplies: "Money",
      activity: "Records", history: "Records", timeline: "Records", documents: "Records",
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
        if (tab === "admin-jobs") setAdminJobsRemountKey((k) => k + 1);
        else if (tab === "equipment") setAdminEquipmentRemountKey((k) => k + 1);
        else if (tab === "payments") setAdminPaymentsRemountKey((k) => k + 1);
        else if (tab === "reminders") setAdminRemindersRemountKey((k) => k + 1);
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
  useEffect(() => {
    const onNav = (e: Event) => {
      const { tab } = (e as CustomEvent).detail || {};
      if (!tab) return;
      const current = getCurrentNavState();
      const wouldChange = current.outer !== "super" || current.inner !== tab;
      if (wouldChange) pushNavHistory(current);
      programmaticNavRef.current = true;
      setTopTab("super");
      setSuperInnerTab(tab as any);
      if (tab === "supplies" || tab === "ledger" || tab === "payments" || tab === "pricing" || tab === "reconcile") setSuperCategory("Money");
      else if (tab === "operations" || tab === "audit" || tab === "documents" || tab === "timeline") setSuperCategory("Records");
      else if (tab === "settings" || tab === "profile") setSuperCategory("System");
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
      setActiveWorkflow("new-job-setup");
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

  // In-app workflow launcher — components dispatch `launch:workflow` with a
  // detail.workflow string to kick off a guided flow without going through a URL.
  useEffect(() => {
    const onLaunch = (e: Event) => {
      const wf = (e as CustomEvent<{ workflow?: string }>).detail?.workflow;
      if (wf) setActiveWorkflow(wf);
    };
    window.addEventListener("launch:workflow", onLaunch as EventListener);
    return () => window.removeEventListener("launch:workflow", onLaunch as EventListener);
  }, []);

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
      setAdminInnerTab("admin-jobs");
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

  const goToGuaranteedPayoutExpiring = useCallback(() => {
    // Title-bar "Guaranteed payout expiring" alert chip routes here —
    // Super → Directory → Users with the guaranteed-payout filter set to
    // "expiring" so the operator sees only the contractors needing
    // attention in the next 7 days.
    window.sessionStorage.setItem(
      "admin:usersOpenOnce",
      JSON.stringify({ guaranteedPayoutFilter: "expiring" }),
    );
    setTopTab("super");
    setSuperInnerTab("users");
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("admin:openUsers", {
          detail: { guaranteedPayoutFilter: "expiring" as const },
        }),
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
    const oldest = pendingWorkdaysByDate[0]?.workdayDate ?? null;
    setWorkdaysJumpDate(oldest);
    setWorkdaysJumpNonce((n) => n + 1);
  }, [pendingWorkdaysByDate]);

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
            <HStack
              gap="2"
              align="center"
            >
              <style>{`
                @keyframes pulse-dot {
                  0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(234,179,8,0.4); }
                  50% { opacity: 0.6; transform: scale(1.5); box-shadow: 0 0 6px 3px rgba(234,179,8,0.25); }
                }
              `}</style>
              {/* Online/offline indicator is now an overlay dot on the top-right
               *  corner of the Seedlings icon (staff only — clients have no
               *  offline-queued actions and shouldn't see network state in the
               *  chrome). The queue badge stays separate when count > 0 because
               *  it shows the count number, which needs more space than a dot. */}
              <Box
                position="relative"
                cursor="pointer"
                onClick={() => {
                  // Record current location before navigating, so the back button works.
                  const current = getCurrentNavState();
                  if (isWorker || isAdmin) {
                    if (current.outer !== "worker" || current.inner !== "jobs") pushNavHistory(current);
                    setTopTab("worker");
                    setWorkerInnerTab("jobs" as any);
                    // Reset JobsTab filters to the default "Now (3 days)" view.
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent("jobs:applyFilter", { detail: { datePreset: "now" } }));
                    }, 300);
                  } else {
                    if (current.outer !== "client") pushNavHistory(current);
                    setTopTab("client");
                  }
                }}
                _hover={{ opacity: 0.8 }}
              >
                <BrandLabel size={BRAND_ICON_H} showText showUserControls={false} />
                {hasAnyRole && (
                  <Box
                    position="absolute"
                    top="-2px"
                    left={`${BRAND_ICON_H - 8}px`}
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
                )}
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
          </Box>

          {/* Right: badges + worker type + Clerk */}
          <div
            ref={headerBtnRef as any}
            style={{
              justifySelf: "end",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              lineHeight: 0,
              minHeight: `${BRAND_ICON_H}px`,
            }}
          >
            {/* Weather chip — small current-temp + icon in the title bar.
                Click cycles the bar below through hidden → collapsed →
                expanded → hidden. Renders whenever weather data is known
                regardless of role (clients can use it too). */}
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
              </Box>
            )}
            {/* Earnings pill — click cycles Today → Wk → Mo → All.
                (Experiment: replaced the weather toggle. To revert, restore from git.) */}
            {earnings != null && (
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
              const alerts: { label: string; count: number; bg: string; color: string; dotColor: string; onClick: () => void }[] = [];
              if (isAdmin && overdueCount > 0) alerts.push({ label: "Overdue", count: overdueCount, bg: "#FEE2E2", color: "#991B1B", dotColor: "#EF4444", onClick: goToOverdue });
              if (isSuper && pending > 0) alerts.push({ label: "Pending Users", count: pending, bg: "#FFEDD5", color: "#9A3412", dotColor: "#FB923C", onClick: goToApprovals });
              if (isSuper && guaranteedPayoutExpiringCount > 0) alerts.push({
                label: "Guaranteed payout expiring",
                count: guaranteedPayoutExpiringCount,
                bg: "#FEF3C7",
                color: "#854D0E",
                dotColor: "#EAB308",
                onClick: goToGuaranteedPayoutExpiring,
              });
              // Payments to review — combined alert that rolls up
              // pending-admin-approval payments + outstanding client
              // payment requests. Both used to be separate entries
              // that routed to the same Super → Payments tab, so we
              // collapsed them into a single, generically-named item.
              // Stale-aware color: when ANY outstanding request has
              // aged past the threshold, the alert switches to orange
              // tones as a visual prompt to follow up — same logic
              // the old "Awaiting payment" entry used.
              if (isSuper) {
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
              if (isSuper && pendingWorkdays > 0) alerts.push({ label: "Workdays to approve", count: pendingWorkdays, bg: "#E0E7FF", color: "#3730A3", dotColor: "#6366F1", onClick: goToWorkdayApprovals });
              if (isSuper && ledgerFollowupCount > 0) alerts.push({ label: "Ledger followups", count: ledgerFollowupCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToLedgerFollowups });
              if (isAdmin && changeRequestCount > 0) alerts.push({ label: "Client requests", count: changeRequestCount, bg: "#FFEDD5", color: "#9A3412", dotColor: "#F97316", onClick: goToClientRequests });
              if (isAdmin && estimateFollowupCount > 0) alerts.push({ label: "Estimate follow-ups", count: estimateFollowupCount, bg: "#FCE7F3", color: "#9D174D", dotColor: "#EC4899", onClick: goToEstimateFollowups });
              if (isAdmin && unapprovedHoursCount > 0) alerts.push({ label: "Job hours awaiting review", count: unapprovedHoursCount, bg: "#FEF3C7", color: "#92400E", dotColor: "#F59E0B", onClick: goToUnapprovedHours });
              if (isAdmin && unclaimedCount > 0) alerts.push({ label: "Unclaimed", count: unclaimedCount, bg: "#FEF9C3", color: "#713F12", dotColor: "#FACC15", onClick: goToUnclaimed });
              if (planningCount > 0) alerts.push({ label: "Planning", count: planningCount, bg: "#CFFAFE", color: "#155E75", dotColor: "#06B6D4", onClick: goToPlanning });
              if (announcementCount > 0) alerts.push({ label: "Announcements", count: announcementCount, bg: "#EDE9FE", color: "#4C1D95", dotColor: "#6D28D9", onClick: goToAnnouncements });
              if (isAdmin && timelineUrgentCount > 0) alerts.push({ label: "Timeline", count: timelineUrgentCount, bg: "#E0E7FF", color: "#3730A3", dotColor: "#6366F1", onClick: goToTimeline });
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
                      {/* Manual refresh — re-fires every alert count so the
                          dropdown stays accurate after actions whose event
                          plumbing might not have reached every listener. */}
                      <Box w="full" h="1px" bg="gray.300" my={1} />
                      <Button
                        size="sm"
                        variant="ghost"
                        w="full"
                        justifyContent="start"
                        gap={2}
                        color="fg.muted"
                        disabled={alertsRefreshing}
                        onClick={(e) => { e.stopPropagation(); void refreshAllAlerts(); }}
                      >
                        {/* Same 22px slot as the count-dot above so the
                            label text aligns under the alert labels. */}
                        <Box
                          w="22px" h="22px" minW="22px"
                          display="flex" alignItems="center" justifyContent="center"
                          flexShrink={0}
                        >
                          {alertsRefreshing ? <Spinner size="xs" /> : <FiRefreshCw size={14} />}
                        </Box>
                        <Text flex="1" textAlign="left">Refresh</Text>
                      </Button>
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
                in-app Profile page to land on. */}
            {mounted && isSignedIn && hasAnyRole ? (
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
                flexShrink={0}
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
          worker/admin/super. Logged-out visitors and signed-in clients still
          see weather (via IP-based fallback) without a permission prompt. */}
      <WeatherBar
        allowGeolocation={!!(me?.isApproved && hasAnyRole)}
        mode={weatherMode}
        onModeChange={setWeatherMode}
      />
      {!meLoading && me && !me.isApproved && <AwaitingApprovalNotice />}
      {!meLoading && me?.isApproved && !hasAnyRole && topTab !== "client" && <NoRoleNotice />}
      {authLoaded && (!isSignedIn || me) && (
        <BreadcrumbNav
          outerTabs={navTabs}
          outerValue={topTab}
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
          }
        />
      )}
      {/* Offline Queue Dialog */}
      <OfflineQueueDialog open={queueDialogOpen} onOpenChange={setQueueDialogOpen} />

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
