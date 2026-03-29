"use client";
import { useEffect, useState, useCallback, useRef, ReactNode } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { Badge, Box, Button, Container, HStack, Select, Text, createListCollection } from "@chakra-ui/react";
import { AlertTriangle, Plus } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import { UserButton, useAuth } from "@clerk/clerk-react";

import UsersTab from "@/src/ui/tabs/UsersTab";
import ActivityTab from "@/src/ui/tabs/ActivityTab";
import AuditLogTab from "@/src/ui/tabs/AuditLogTab";
import SettingsTab from "@/src/ui/tabs/SettingsTab";
import EquipmentTab from "@/src/ui/tabs/EquipmentTab";
import JobsTab from "@/src/ui/tabs/JobsTab";
import ClientsTab from "@/src/ui/tabs/ClientsTab";
import PropertiesTab from "@/src/ui/tabs/PropertiesTab";
import PaymentsTab from "@/src/ui/tabs/PaymentsTab";
import ServicesTab from "@/src/ui/tabs/ServicesTab";
import AdminJobsTab from "@/src/ui/tabs/AdminJobsTab";
import ClientFeedTab from "@/src/ui/tabs/ClientFeedTab";

import AppSplash from "@/src/ui/helpers/AppSplash";
import AwaitingApprovalNotice from "@/src/ui/notices/AwaitingApprovalNotice";
import NoRoleNotice from "@/src/ui/notices/NoRoleNotice";

import InlineMessage from "@/src/ui/components/InlineMessage";
import { type WorkflowDef } from "@/src/ui/components/WorkflowToolbar";
import NewJobSetupWorkflow from "@/src/ui/components/NewJobSetupWorkflow";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

import { Me, Role, AdminTabs, WorkerTabs, EventTypes } from "@/src/lib/types";
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
  FiSettings,
} from "react-icons/fi";
import { GrUserAdmin } from "react-icons/gr";
import { AiOutlineTeam } from "react-icons/ai";
import { TfiMoney } from "react-icons/tfi";

import ScrollableUnderlineTabs, {
  TabItem,
} from "../src/ui/components/ScrollableUnderlineTabs";

const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

export default function HomePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();

  const [me, setMe] = useState<Me | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isWorker = hasRole(me?.roles, "WORKER");
  const hasAnyRole = (me?.roles?.length ?? 0) > 0;

  const [topTab, setTopTab] = usePersistedState<"client" | "worker" | "admin">("topTab", "client");

  const [adminInnerTab, setAdminInnerTab] = usePersistedState<AdminTabs>("adminTab", "admin-jobs");
  const [workerInnerTab, setWorkerInnerTab] = usePersistedState<WorkerTabs>("workerTab", "jobs");

  const [activeWorkflow, setActiveWorkflow] = useState<string | null>(null);

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

  const adminWorkflows: WorkflowDef[] = [
    {
      id: "new-job-setup",
      label: "New Job",
      colorPalette: "green",
      onClick: () => setActiveWorkflow("new-job-setup"),
    },
    {
      id: "export-summary",
      label: "Summary",
      colorPalette: "blue",
      shades: [50, 600, 300, 100] as [number, number, number, number],
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
      label: "Export All",
      colorPalette: "blue",
      shades: [200, 900, 500, 300] as [number, number, number, number],
      onClick: () =>
        setConfirmAction({
          title: "Export Raw Data",
          message: "This will download all raw data as JSON. This may be a large file. Continue?",
          confirmLabel: "Download",
          colorPalette: "blue",
          onConfirm: downloadRaw,
        }),
    },
  ];

  const workflowItems = adminWorkflows.map((w) => ({ label: w.label, value: w.id }));
  const workflowCollection = createListCollection({ items: workflowItems });

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

  const workerTabs: TabItem[] = [
    {
      value: "jobs",
      label: "Jobs",
      icon: FiBriefcase,
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
  ];

  const adminTabs: TabItem[] = [
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
      value: "users",
      label: "Users",
      icon: AiOutlineTeam,
      content: wrapWithInlineMessage(<UsersTab role="admin" />),
    },
    {
      value: "activity",
      label: "Activity",
      icon: FiActivity,
      content: wrapWithInlineMessage(<ActivityTab role="admin" />),
    },
    {
      value: "audit",
      label: "Audit",
      icon: FiFileText,
      content: wrapWithInlineMessage(<AuditLogTab role="admin" />),
    },
    {
      value: "settings",
      label: "Settings",
      icon: FiSettings,
      content: wrapWithInlineMessage(<SettingsTab me={me} purpose="ADMIN" />),
    },
  ];

  const outerTabs: TabItem[] = [
    {
      value: "client",
      label: "Client",
      icon: FiHome,
      visible: true,
      content: <ClientFeedTab />,
    },
    {
      value: "worker",
      label: "Worker",
      icon: FiUser,
      visible: () => !!isSignedIn && !!me?.isApproved && isWorker,
      content: (
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
          <ScrollableUnderlineTabs
            tabs={workerTabs}
            value={workerInnerTab}
            onValueChange={(v) => setWorkerInnerTab(v as WorkerTabs)}
            edgeMode="overlay"
            edgeSize={16}
            headerPaddingY={0}
            unmountOnExit
          />
        </>
      ),
    },
    {
      value: "admin",
      label: "Admin",
      icon: GrUserAdmin,
      visible: () => !!isSignedIn && isAdmin,
      content: (
        <>
          <NewJobSetupWorkflow
            active={activeWorkflow === "new-job-setup"}
            onDone={() => setActiveWorkflow(null)}
            onComplete={() => window.location.reload()}
          />
          <ScrollableUnderlineTabs
            tabs={adminTabs}
            value={adminInnerTab}
            onValueChange={(v) => setAdminInnerTab(v as AdminTabs)}
            edgeMode="overlay"
            edgeSize={16}
            headerPaddingY={0}
            unmountOnExit
          />
        </>
      ),
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

  const BRAND_ICON_H = 26; // px

  // De-dup the Clerk button robustly
  const headerBtnRef = useRef<HTMLDivElement | null>(null);
  const [showLocalUserBtn, setShowLocalUserBtn] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const isInsideHeader = (el: Element | null) =>
      !!(el && headerBtnRef.current && headerBtnRef.current.contains(el));

    const hasExternalClerkButton = () => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.cl-userButton-root, [class*="cl-userButton"], [data-cl-component="UserButton"]'
        )
      );
      return nodes.some((n) => !isInsideHeader(n));
    };

    const raf = requestAnimationFrame(() => {
      setShowLocalUserBtn(!hasExternalClerkButton());
    });

    const obs = new MutationObserver(() => {
      const external = hasExternalClerkButton();
      setShowLocalUserBtn(!external);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, []);

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

  const goToApprovals = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("admin:openUsers", {
        detail: { status: "pending" as const },
      })
    );
  }, []);

  return (
    <Container maxW="5xl" py={8}>
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
        mb={2}
      >
        {/* GRID header: left brand, right controls */}
        <Box
          display="grid"
          gridTemplateColumns="1fr auto"
          alignItems="center"
          columnGap={3}
          minH={`${BRAND_ICON_H}px`}
        >
          {/* Left: brand with your 1px nudge */}
          <Box
            display="flex"
            alignItems="center"
            lineHeight="0"
            style={{ transform: "translateY(1px)" }}
          >
            <BrandLabel size={BRAND_ICON_H} showText />
          </Box>

          {/* Right: badge (left) + Clerk (right). Order is enforced explicitly. */}
          <HStack
            ref={headerBtnRef}
            justifySelf="end"
            align="center"
            gap="8px"
            lineHeight="0"
            minH={`${BRAND_ICON_H}px`}
            // Ensure LTR flow
            style={{ direction: "ltr" }}
          >
            {/* Pending badge */}
            {isAdmin && pending > 0 && (
              <Box
                as="button"
                aria-label="Pending approvals"
                title="Pending approvals"
                onClick={goToApprovals}
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
                style={{ order: 0 }}
              >
                {pending}
              </Box>
            )}

            {/* Worker type badge (order 1) */}
            {me && (
              <Badge
                style={{ order: 1 }}
                size="sm"
                variant="subtle"
                colorPalette={
                  me.workerType === "EMPLOYEE" ? "blue"
                  : me.workerType === "CONTRACTOR" ? "orange"
                  : me.workerType === "TRAINEE" ? "cyan"
                  : "gray"
                }
                lineHeight="normal"
              >
                {me.workerType === "EMPLOYEE" ? "W-2"
                  : me.workerType === "CONTRACTOR" ? "1099"
                  : me.workerType === "TRAINEE" ? "Trainee"
                  : "Unclassified"}
              </Badge>
            )}

            {/* Clerk (order 2) */}
            <Box style={{ order: 2 }} display="flex" alignItems="center">
              {mounted && showLocalUserBtn ? (
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
              ) : null}
            </Box>
          </HStack>
        </Box>
      </Box>
      {!meLoading && me && !me.isApproved && topTab !== "client" && <AwaitingApprovalNotice />}
      {!meLoading && me?.isApproved && !hasAnyRole && topTab !== "client" && <NoRoleNotice />}
      {authLoaded && (!isSignedIn || me) && (
        <ScrollableUnderlineTabs
          tabs={outerTabs}
          value={topTab}
          onValueChange={(v) => setTopTab(v as typeof topTab)}
          edgeMode="overlay"
          edgeSize={16}
          headerPaddingY={0}
          unmountOnExit
          headerRight={isAdmin && topTab === "admin" ? (
            <Select.Root
              collection={workflowCollection}
              value={[]}
              onValueChange={(e) => {
                const wf = adminWorkflows.find((w) => w.id === e.value[0]);
                if (wf) wf.onClick();
              }}
              size="sm"
              positioning={{ strategy: "fixed", hideWhenDetached: true }}
              css={{ width: "auto", flex: "0 0 auto" }}
            >
              <Select.Control>
                <Select.Trigger
                  w="auto"
                  minW="0"
                  px="2"
                  py="1"
                  mr="2"
                  css={{
                    background: "var(--chakra-colors-gray-100)",
                    borderRadius: "6px",
                    border: "1px solid var(--chakra-colors-gray-300)",
                    "&:hover": { background: "var(--chakra-colors-gray-200)" },
                  }}
                >
                  <Plus size={16} color="var(--chakra-colors-gray-600)" />
                  <Select.Indicator display="none" />
                </Select.Trigger>
              </Select.Control>
              <Select.Positioner>
                <Select.Content>
                  {workflowItems.map((it) => (
                    <Select.Item key={it.value} item={it.value}>
                      <Select.ItemText>{it.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Select.Root>
          ) : undefined}
        />
      )}
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
