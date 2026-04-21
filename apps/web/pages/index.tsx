"use client";
import { useEffect, useState, useCallback, useRef, ReactNode } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, Container, Dialog, HStack, Portal, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle, ArrowLeftCircle } from "lucide-react";
import { useOffline } from "@/src/lib/offline";
import OfflineQueueDialog from "@/src/ui/dialogs/OfflineQueueDialog";
import { apiGet } from "@/src/lib/api";
import { bizDateKey } from "@/src/lib/lib";
import { computeDatesFromPreset } from "@/src/lib/datePresets";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import { UserButton, SignInButton, useAuth } from "@clerk/clerk-react";

import UsersTab from "@/src/ui/tabs/UsersTab";
import ActivityTab from "@/src/ui/tabs/ActivityTab";
import HistoryTab from "@/src/ui/tabs/HistoryTab";
import SettingsTab from "@/src/ui/tabs/SettingsTab";
import SuperUnclaimedTab from "@/src/ui/tabs/SuperUnclaimedTab";
import OperationsTab from "@/src/ui/tabs/OperationsTab";
import AuditTab from "@/src/ui/tabs/AuditTab";
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
import PlanWorkdayWorkflow from "@/src/ui/workflows/PlanWorkdayWorkflow";
import BeginWorkDayWorkflow from "@/src/ui/workflows/BeginWorkDayWorkflow";
import AdminTasksTab, { type TaskDef, FiPlus, FiDownload, FiDatabase, FiShare2 } from "@/src/ui/tabs/AdminTasksTab";
import SharePhotosWorkflow from "@/src/ui/workflows/SharePhotosWorkflow";
import StatisticsTab from "@/src/ui/tabs/StatisticsTab";
import ProfileTab from "@/src/ui/tabs/ProfileTab";
import AdminRoutesTab from "@/src/ui/tabs/AdminRoutesTab";
import PreviewRoutesTab from "@/src/ui/tabs/PreviewRoutesTab";

import AppSplash from "@/src/ui/helpers/AppSplash";
import AwaitingApprovalNotice from "@/src/ui/notices/AwaitingApprovalNotice";
import NoRoleNotice from "@/src/ui/notices/NoRoleNotice";

import InlineMessage from "@/src/ui/components/InlineMessage";
import NewJobSetupWorkflow from "@/src/ui/components/NewJobSetupWorkflow";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

import { Me, Role, AdminTabs, ClientTabs, WorkerTabs, SuperTabs, EventTypes } from "@/src/lib/types";
import {
  FiBriefcase,
  FiClipboard,
  FiTool,
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
  const [superInnerTab, setSuperInnerTab] = usePersistedState<SuperTabs>("superTab", "operations");

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
  topTabRef.current = topTab;
  clientInnerTabRef.current = clientInnerTab;
  workerInnerTabRef.current = workerInnerTab;
  adminInnerTabRef.current = adminInnerTab;
  superInnerTabRef.current = superInnerTab;
  workerCategoryRef.current = workerCategory;
  adminCategoryRef.current = adminCategory;

  function getCurrentNavState(): NavState {
    const t = topTabRef.current;
    const inner = t === "client" ? clientInnerTabRef.current
      : t === "worker" ? workerInnerTabRef.current
      : t === "admin" ? adminInnerTabRef.current
      : superInnerTabRef.current;
    const category = t === "worker" ? workerCategoryRef.current : t === "admin" ? adminCategoryRef.current : undefined;
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
    else if (prev.outer === "super") superInnerTabRef.current = prev.inner as any;
    // Now set React state (no skipNextPush needed — onOuterChange/onInnerChange only fire from user clicks)
    setTopTab(prev.outer as any);
    if (prev.outer === "client") setClientInnerTab(prev.inner as any);
    else if (prev.outer === "worker") { setWorkerInnerTab(prev.inner as any); if (prev.category) setWorkerCategory(prev.category); }
    else if (prev.outer === "admin") { setAdminInnerTab(prev.inner as any); if (prev.category) setAdminCategory(prev.category); }
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
      a.download = `seedlings-summary-${new Date().toISOString().slice(0, 10)}.txt`;
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
      a.download = `seedlings-export-${new Date().toISOString().slice(0, 10)}.json`;
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
    {
      value: "public",
      label: "Community",
      icon: FiActivity,
      content: <ClientFeedTab />,
    },
    {
      value: "my-jobs",
      label: "My Properties",
      icon: FiBriefcase,
      visible: () => !!isSignedIn && !!me?.isApproved && !isWorker && !isAdmin,
      content: <ClientMyJobsTab />,
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

  const workerTabs: TabItem[] = [
    {
      value: "tasks",
      label: "Actions",
      icon: FiPlus,
      content: <AdminTasksTab tasks={workerTasks} />,
    },
    {
      value: "reminders",
      label: "Planning",
      icon: FiBell,
      content: wrapWithInlineMessage(<RemindersTab myId={me?.id} me={me} />),
    },
    {
      value: "jobs",
      label: "Jobs",
      icon: FiClipboard,
      content: wrapWithInlineMessage(<JobsTab me={me} purpose="WORKER" />),
    },
    {
      value: "equipment",
      label: "Equipment",
      icon: FiTool,
      content: wrapWithInlineMessage(<EquipmentTab me={me} purpose="WORKER" />),
    },
    {
      value: "payments",
      label: "Payments",
      icon: TfiMoney,
      content: wrapWithInlineMessage(<PaymentsTab me={me} purpose="WORKER" />),
    },
    {
      value: "routes",
      label: "Routes",
      icon: FiNavigation,

      visible: () => !!me?.workerType,
      content: wrapWithInlineMessage(<PreviewRoutesTab />),
    },
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
    {
      value: "statistics",
      label: "Statistics",
      icon: FiBarChart2,

      visible: () => !!me?.workerType,
      content: wrapWithInlineMessage(<StatisticsTab myId={me?.id} />),
    },
    {
      value: "profile",
      label: "Profile",
      icon: FiUser,

      content: wrapWithInlineMessage(<ProfileTab me={me} onProfileUpdated={refreshMe} />),
    },
  ];

  const adminTabs: TabItem[] = [
    {
      value: "tasks",
      label: "Actions",
      icon: FiPlus,
      content: <AdminTasksTab tasks={adminTasks} />,
    },
    {
      value: "reminders",
      label: "Planning",
      icon: FiBell,
      content: wrapWithInlineMessage(<AdminRemindersTab me={me} />),
    },
    {
      value: "admin-jobs",
      label: "Jobs",
      icon: FiClipboard,
      content: wrapWithInlineMessage(<AdminJobsTab me={me} purpose="ADMIN" />),
    },
    {
      value: "jobs",
      label: "Services",
      icon: FiBriefcase,
      content: wrapWithInlineMessage(<ServicesTab me={me} purpose="ADMIN" />),
    },
    {
      value: "equipment",
      label: "Equipment",
      icon: FiTool,
      content: wrapWithInlineMessage(<EquipmentTab me={me} purpose="ADMIN" />),
    },
    {
      value: "payments",
      label: "Payments",
      icon: TfiMoney,
      content: wrapWithInlineMessage(<PaymentsTab me={me} purpose="ADMIN" />),
    },
    {
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
      value: "routes",
      label: "Routes",
      icon: FiNavigation,

      content: wrapWithInlineMessage(<AdminRoutesTab />),
    },
    {
      value: "users",
      label: "Users",
      icon: AiOutlineTeam,

      content: wrapWithInlineMessage(<UsersTab role="admin" />),
    },
    {
      value: "statistics",
      label: "Statistics",
      icon: FiBarChart2,

      content: wrapWithInlineMessage(<StatisticsTab />),
    },
    {
      value: "profile",
      label: "Profile",
      icon: FiUser,

      content: wrapWithInlineMessage(<ProfileTab me={me} isAdmin onProfileUpdated={refreshMe} />),
    },
    {
      value: "activity",
      label: "Activity",
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
        const catMap: Record<string, string> = {
          tasks: "Actions",
          reminders: "Work", jobs: "Work",
          equipment: "Field", routes: "Field",
          payments: "Money", statistics: "Money",
          clients: "Info", properties: "Info", profile: "Info",
        };
        const catIconMap: Record<string, React.ElementType> = {
          Actions: FiPlus, Work: FiClipboard, Field: FiTool, Money: TfiMoney, Info: FiUsers,
        };
        const highlightCats = new Set(["Actions"]);
        return workerTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content, category: catMap[t.value], categoryIcon: catIconMap[catMap[t.value]], categoryHighlight: highlightCats.has(catMap[t.value]) }));
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
          tasks: "Actions",
          reminders: "Work", "admin-jobs": "Work", jobs: "Work",
          equipment: "Field", routes: "Field",
          payments: "Money", statistics: "Money",
          clients: "Directory", properties: "Directory", users: "Directory",
          profile: "System", activity: "System", history: "System", settings: "System",
        };
        const catIconMap: Record<string, React.ElementType> = {
          Actions: FiPlus, Work: FiClipboard, Field: FiTool, Money: TfiMoney, Directory: FiUsers, System: FiSettings,
        };
        const highlightCats = new Set(["Actions"]);
        return adminTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, visible: t.visible, content: t.content, category: catMap[t.value], categoryIcon: catIconMap[catMap[t.value]], categoryHighlight: highlightCats.has(catMap[t.value]) }));
      })(),
    },
    {
      value: "super",
      label: "Super",
      icon: FiShield,
      visible: () => !!isSignedIn && isSuper,
      innerTabs: [
        {
          value: "operations",
          label: "Operations",
          icon: FiBarChart2,
          content: <OperationsTab />,
        },
        {
          value: "audit",
          label: "Audit",
          icon: FiSearch,
          content: <AuditTab />,
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
        if (!q) return;
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
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent(`${eventName}:run`, { detail: payload })
        );
        window.sessionStorage.removeItem(key);
      });
    }, [topTab, adminInnerTab, workerInnerTab]);
  };

  setupSearchEvent("clientTabToPropertiesTabSearch", "properties");
  setupSearchEvent("propertyTabToClientTabSearch", "clients");
  setupSearchEvent("propertyTabToClientTabContactSearch", "clients");
  setupSearchEvent("activityTavToEquipmentTabQRCodeSearch", "equipment");
  setupSearchEvent("jobsTabToPropertiesTabSearch", "properties");
  setupSearchEvent("jobsTabToClientsTabSearch", "clients");
  setupSearchEvent("paymentsTabToPropertiesTabSearch", "properties");
  setupSearchEvent("paymentsTabToClientsTabSearch", "clients");
  setupSearchEvent("paymentsTabToServicesTabSearch", "jobs");
  setupSearchEvent("jobsTabToServicesTabSearch", "jobs");

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
      if (!q) return;
      if (forAdmin) {
        setTopTab("admin");
        setAdminInnerTab("admin-jobs");
      } else {
        setTopTab("worker");
        setWorkerInnerTab("jobs");
      }
      window.sessionStorage.setItem(
        "open:remindersToJobsTabSearchOnce",
        JSON.stringify({ q, entityId }),
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
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("remindersToJobsTabSearch:run", { detail: payload })
      );
      window.sessionStorage.removeItem(key);
    });
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

  const headerBtnRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // ---- Pending approvals badge (admin only) ----
  const [pending, setPending] = useState<number>(0);

  const loadPending = useCallback(async () => {
    if (!isAdmin) {
      setPending(0);
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
  }, [isAdmin]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  // Overdue count for admin header badge — matches Admin Jobs tab overdue logic
  const [overdueCount, setOverdueCount] = useState(0);
  const loadOverdue = useCallback(async () => {
    if (!isAdmin) { setOverdueCount(0); return; }
    try {
      const today = bizDateKey(new Date());
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const toStr = bizDateKey(yesterday);
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 60);
      const fromStr = bizDateKey(monthAgo);
      const list = await apiGet<any[]>(`/api/occurrences?from=${fromStr}&to=${toStr}`);
      const excludeStatuses = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      const count = (Array.isArray(list) ? list : []).filter(
        (o) => o.startAt && !excludeStatuses.has(o.status) &&
          bizDateKey(o.startAt) < today &&
          bizDateKey(o.startAt) >= fromStr
      ).length;
      setOverdueCount(count);
    } catch {
      setOverdueCount(0);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadOverdue();
    // Also refresh when jobs change (e.g., status update, payment accepted)
    const onRefresh = () => void loadOverdue();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadOverdue]);

  // Unclaimed count for admin header badge
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const loadUnclaimed = useCallback(async () => {
    if (!isAdmin) { setUnclaimedCount(0); return; }
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
  }, [isAdmin]);

  useEffect(() => {
    void loadUnclaimed();
    const onRefresh = () => void loadUnclaimed();
    window.addEventListener("seedlings3:jobs-changed", onRefresh);
    return () => window.removeEventListener("seedlings3:jobs-changed", onRefresh);
  }, [loadUnclaimed]);

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

  // Planning badge count — items on the worker's Planning tab that haven't been dismissed
  const [planningCount, setPlanningCount] = useState(0);
  // Single dashboard summary replaces multiple separate API calls for badge counts
  const loadDashboardSummary = useCallback(async () => {
    if (!me?.id) { setPlanningCount(0); return; }
    try {
      const list = await apiGet<any[]>("/api/occurrences");
      if (!Array.isArray(list)) { setPlanningCount(0); return; }

      // Filter to my assigned items, exclude ghosts
      const myId = me.id;
      const myItems = list
        .filter((occ: any) => !occ._isReminderGhost && !occ._isPinnedGhost)
        .filter((occ: any) => (occ.assignees ?? []).some((a: any) => a.userId === myId));

      // Load dismissed IDs (same logic as RemindersTab)
      let dismissedIds = new Set<string>();
      try {
        const raw = localStorage.getItem("seedlings_reminders_dismissed");
        if (raw) {
          const data = JSON.parse(raw);
          if (data.date === new Date().toISOString().slice(0, 10)) {
            dismissedIds = new Set(data.ids ?? []);
          }
        }
      } catch {}
      const notDismissed = (occ: any) => !dismissedIds.has(occ.id);

      const todayKey = bizDateKey(new Date());
      const tomorrowD = new Date(); tomorrowD.setDate(tomorrowD.getDate() + 1);
      const tomorrowKey = bizDateKey(tomorrowD);

      // Exact same filters as RemindersTab — sum of all sections (items CAN appear in multiple sections)
      // Scoped dismissals — section:occId keys match RemindersTab exactly
      const overdueExclude = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      const activeStatuses = new Set(["SCHEDULED", "IN_PROGRESS", "ACCEPTED"]);
      const upcomingStatuses = new Set(["SCHEDULED", "ACCEPTED"]);

      const followUps = myItems.filter((occ: any) => occ.reminder && bizDateKey(occ.reminder.remindAt) <= todayKey && !dismissedIds.has(`followups:${occ.id}`)).length;
      const overdueCount = myItems.filter((occ: any) => occ.startAt && !overdueExclude.has(occ.status) && bizDateKey(occ.startAt) < todayKey && !dismissedIds.has(`overdue:${occ.id}`)).length;
      const todayCount = myItems.filter((occ: any) => activeStatuses.has(occ.status) && occ.startAt && bizDateKey(occ.startAt) === todayKey && !dismissedIds.has(`today:${occ.id}`)).length;
      const tomorrowCount = myItems.filter((occ: any) => upcomingStatuses.has(occ.status) && occ.startAt && bizDateKey(occ.startAt) === tomorrowKey && !dismissedIds.has(`tomorrow:${occ.id}`)).length;
      const pendingCount = myItems.filter((occ: any) => occ.status === "PENDING_PAYMENT" && !dismissedIds.has(`pending:${occ.id}`)).length;
      const estimatesCount = myItems.filter((occ: any) => occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && !dismissedIds.has(`estimates:${occ.id}`)).length;
      const routePlan = dismissedIds.has("__route_plan__") ? 0 : 1;

      setPlanningCount(followUps + overdueCount + todayCount + tomorrowCount + pendingCount + estimatesCount + routePlan);
    } catch {
      setPlanningCount(0);
    }
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
      const { tab, autoAnalyze } = (e as CustomEvent).detail || {};
      if (tab) {
        programmaticNavRef.current = true;
        setTopTab("worker");
        setWorkerInnerTab(tab);
        if (autoAnalyze && tab === "routes") {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("routes:autoAnalyze"));
          }, 300);
        }
        // Reset flag after React processes the state update
        setTimeout(() => { programmaticNavRef.current = false; }, 50);
      }
    };
    window.addEventListener("navigate:workerTab", onNav as EventListener);
    return () => window.removeEventListener("navigate:workerTab", onNav as EventListener);
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

  // Deep-link to a specific occurrence (e.g., ?occ=OCCURRENCE_ID or ?occ=OCCURRENCE_ID&view=admin)
  // Uses localStorage (not sessionStorage) so it survives OAuth redirects and page reloads.
  // Only strips the URL params after the user is authenticated and the deep link is consumed.
  useEffect(() => {
    const occId = router.query.occ as string | undefined;
    const view = router.query.view as string | undefined;
    if (occId) {
      try {
        localStorage.setItem("seedlings_deeplink_occ", occId);
        if (view) localStorage.setItem("seedlings_deeplink_view", view);
        localStorage.setItem("seedlings_deeplink_ts", String(Date.now()));
      } catch {}
      // Only strip URL if user is already signed in; otherwise leave it
      // so Clerk can redirect back with the params intact after auth
      if (isSignedIn) {
        router.replace("/", undefined, { shallow: true });
      }
    }
  }, [router.query.occ, isSignedIn]);

  useEffect(() => {
    if (meLoading || !me?.isApproved) return;
    let occId: string | null = null;
    let view: string | null = null;
    try {
      occId = localStorage.getItem("seedlings_deeplink_occ");
      view = localStorage.getItem("seedlings_deeplink_view");
      const ts = localStorage.getItem("seedlings_deeplink_ts");
      // Discard stale deep links (older than 5 minutes)
      if (ts && Date.now() - Number(ts) > 5 * 60 * 1000) {
        occId = null;
      }
    } catch {}
    if (!occId) {
      try { localStorage.removeItem("seedlings_deeplink_occ"); localStorage.removeItem("seedlings_deeplink_view"); localStorage.removeItem("seedlings_deeplink_ts"); } catch {}
      return;
    }
    try {
      localStorage.removeItem("seedlings_deeplink_occ");
      localStorage.removeItem("seedlings_deeplink_view");
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
    let attempts = 0;
    const maxAttempts = 30; // 30 x 100ms = 3 seconds max
    const interval = setInterval(() => {
      attempts++;
      if ((window as any).__jobsTabReady || attempts >= maxAttempts) {
        clearInterval(interval);
        if (view !== "admin") {
          window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "jobs" } }));
        }
        window.dispatchEvent(new CustomEvent("jobsTab:highlightOcc", { detail: { occId: savedOccId } }));
      }
    }, 100);
    return () => clearInterval(interval);
  }, [me?.isApproved, meLoading]);

  const goToApprovals = useCallback(() => {
    window.sessionStorage.setItem("admin:usersOpenOnce", JSON.stringify({ status: "pending" }));
    setTopTab("admin");
    setAdminInnerTab("users");
    // Also dispatch event for when component is already mounted
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("admin:openUsers", {
          detail: { status: "pending" as const },
        })
      );
    }, 100);
  }, []);

  return (
    <Container maxW="5xl" pt={4} pb={8}>
      <AppSplash show={!authLoaded || (isSignedIn && meLoading)} />
      <Box
        as="header"
        bg="#f4f7f0"
        bgGradient="linear(to-b, #f4f7f0, #f9faf7)"
        borderWidth="1px"
        borderColor="#b5c4a3"
        px={{ base: 3, md: 4 }}
        py={{ base: 2, md: 3 }}
        borderRadius="md"
        mb={1}
      >
        {/* GRID header: left brand, right controls */}
        <Box
          display="grid"
          gridTemplateColumns="1fr auto"
          alignItems="center"
          columnGap={3}
          minH={`${BRAND_ICON_H}px`}
        >
          {/* Left: brand + alert badges */}
          <Box
            display="flex"
            alignItems="center"
            gap="8px"
            lineHeight="0"
            style={{ transform: "translateY(1px)" }}
          >
            <HStack
              gap="2"
              align="center"
              cursor="pointer"
              onClick={() => setNetworkInfoOpen(true)}
              _hover={{ opacity: 0.8 }}
            >
              <style>{`
                @keyframes pulse-dot {
                  0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(234,179,8,0.4); }
                  50% { opacity: 0.6; transform: scale(1.5); box-shadow: 0 0 6px 3px rgba(234,179,8,0.25); }
                }
              `}</style>
              <Box
                w="10px"
                h="10px"
                borderRadius="full"
                bg={isOffline ? (isForceOffline ? "orange.400" : "red.400") : queueCount > 0 ? "yellow.400" : "green.400"}
                flexShrink={0}
                _hover={{ transform: "scale(1.3)" }}
                transition="transform 0.1s"
                style={!isOffline && queueCount > 0 ? { animation: "pulse-dot 1.2s ease-in-out infinite" } : undefined}
              />
              {queueCount > 0 && (
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
              <BrandLabel size={BRAND_ICON_H} showText showUserControls={false} />
            </HStack>
          </Box>

          {/* Right: badges + worker type + Clerk */}
          <div
            ref={headerBtnRef as any}
            style={{
              justifySelf: "end",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              lineHeight: 0,
              minHeight: `${BRAND_ICON_H}px`,
            }}
          >
            {isAdmin && pending > 0 && (
              <Box
                as="button"
                aria-label="Pending approvals"
                title={`${pending} pending approval${pending !== 1 ? "s" : ""}`}
                onClick={goToApprovals}
                width="22px"
                height="22px"
                minW="22px"
                borderRadius="9999px"
                bg="orange.400"
                color="white"
                fontSize="12px"
                fontWeight="bold"
                display="flex"
                alignItems="center"
                justifyContent="center"
                _hover={{ bg: "orange.500" }}
                _active={{ transform: "translateY(1px)" }}
              >
                {pending}
              </Box>
            )}
            {isAdmin && unclaimedCount > 0 && (
              <Box
                as="button"
                aria-label="Unclaimed jobs"
                title={`${unclaimedCount} unclaimed job${unclaimedCount !== 1 ? "s" : ""} (last 60 days + next 3 days)`}
                onClick={goToUnclaimed}
                width="22px"
                height="22px"
                minW="22px"
                borderRadius="9999px"
                bg="yellow.400"
                color="yellow.900"
                fontSize="12px"
                fontWeight="bold"
                display="flex"
                alignItems="center"
                justifyContent="center"
                _hover={{ bg: "yellow.500" }}
                _active={{ transform: "translateY(1px)" }}
              >
                {unclaimedCount}
              </Box>
            )}
            {isAdmin && overdueCount > 0 && (
              <Box
                as="button"
                aria-label="Overdue jobs"
                title={`${overdueCount} overdue job${overdueCount !== 1 ? "s" : ""} (last 60 days)`}
                onClick={goToOverdue}
                width="22px"
                height="22px"
                minW="22px"
                borderRadius="9999px"
                bg="red.500"
                color="white"
                fontSize="12px"
                fontWeight="bold"
                display="flex"
                alignItems="center"
                justifyContent="center"
                _hover={{ bg: "red.600" }}
                _active={{ transform: "translateY(1px)" }}
              >
                {overdueCount}
              </Box>
            )}
            {planningCount > 0 && (
              <Box
                as="button"
                aria-label="Planning items"
                title={`${planningCount} planning item${planningCount !== 1 ? "s" : ""}`}
                onClick={goToPlanning}
                width="22px"
                height="22px"
                minW="22px"
                borderRadius="9999px"
                bg="cyan.500"
                color="white"
                fontSize="12px"
                fontWeight="bold"
                display="flex"
                alignItems="center"
                justifyContent="center"
                _hover={{ bg: "cyan.600" }}
                _active={{ transform: "translateY(1px)" }}
              >
                {planningCount}
              </Box>
            )}
            {me && hasAnyRole && (
              <Badge
                size="sm"
                variant="subtle"
                colorPalette={
                  me.workerType === "EMPLOYEE" ? "blue"
                  : me.workerType === "CONTRACTOR" ? "orange"
                  : me.workerType === "TRAINEE" ? "cyan"
                  : "gray"
                }
                lineHeight="normal"
                cursor="pointer"
                onClick={() => {
                  setTopTab("worker");
                  setWorkerInnerTab("profile" as any);
                }}
              >
                {me.workerType === "EMPLOYEE" ? "W-2"
                  : me.workerType === "CONTRACTOR" ? "1099"
                  : me.workerType === "TRAINEE" ? "Trainee"
                  : "Unclassified"}
              </Badge>
            )}
            {isSignedIn && !hasAnyRole && me?.isApproved && (
              <Badge size="sm" variant="subtle" colorPalette="green" lineHeight="normal">
                Client
              </Badge>
            )}
            {mounted && isSignedIn ? (
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
              <SignInButton mode="modal">
                <Text
                  as="button"
                  fontSize="sm"
                  color="blue.600"
                  _hover={{ textDecoration: "underline" }}
                >
                  Sign in
                </Text>
              </SignInButton>
            ) : null}
          </div>
        </Box>
      </Box>
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
          categoryValue={topTab === "worker" ? workerCategory : topTab === "admin" ? adminCategory : undefined}
          onCategoryChange={(v: string) => {
            const currentCat = topTab === "worker" ? workerCategory : topTab === "admin" ? adminCategory : undefined;
            if (v !== currentCat) pushNavHistory(getCurrentNavState());
            if (topTab === "worker") setWorkerCategory(v);
            else if (topTab === "admin") setAdminCategory(v);
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
              color={canGoBack ? "blue.600" : "gray.300"}
              opacity={canGoBack ? 1 : 0.4}
              cursor={canGoBack ? "pointer" : "default"}
              _hover={canGoBack ? { color: "blue.700" } : {}}
              transition="all 0.1s"
              style={{ pointerEvents: canGoBack ? "auto" : "none" }}
            >
              <ArrowLeftCircle size={18} />
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
                      When you have no internet (or force offline mode is on), the app serves data from its local cache. You can view your job schedule, property details, notes, and team info — but you cannot perform actions like starting jobs, accepting payments, or editing records.
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
  );
}
