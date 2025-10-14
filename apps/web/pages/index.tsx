"use client";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Box, Container, HStack } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import { UserButton } from "@clerk/clerk-react";

import WorkerEquipment from "@/src/ui/tabs/WorkerEquipment";
import WorkerJobs from "@/src/ui/tabs/WorkerJobs";

import AdminEquipment from "@/src/ui/tabs/AdminEquipment";
import AdminUsers from "@/src/ui/tabs/AdminUsers";
import AdminActivity from "@/src/ui/tabs/AdminActivity";
import AdminAuditLog from "@/src/ui/tabs/AdminAuditLog";

import Clients from "@/src/ui/tabs/Clients";

import AppSplash from "@/src/ui/helpers/AppSplash";
import AwaitingApprovalNotice from "@/src/ui/notices/AwaitingApprovalNotice";
import NoRoleNotice from "@/src/ui/notices/NoRoleNotice";

import { Me, Role } from "@/src/lib/types";
import {
  FiBriefcase,
  FiMap,
  FiSettings,
  FiTool,
  FiUser,
  FiUsers,
} from "react-icons/fi";

import ScrollableUnderlineTabs, {
  TabItem,
} from "../src/ui/components/ScrollableUnderlineTabs";

const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

export default function HomePage() {
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  const workerTabs: TabItem[] = [
    {
      value: "equipment",
      label: "Equipment",
      icon: FiTool,
      content: <WorkerEquipment />,
    },
    {
      value: "jobs",
      label: "Jobs",
      icon: FiBriefcase,
      content: <WorkerJobs />,
    },
    { value: "clients", label: "Clients", icon: FiUser, content: <Clients /> },
  ];

  const adminTabs: TabItem[] = [
    {
      value: "equipment",
      label: "Equipment",
      icon: FiTool,
      content: <AdminEquipment />,
    },
    {
      value: "users",
      label: "Users",
      icon: FiUsers,
      content: <AdminUsers />,
    },
    {
      value: "activity",
      label: "Activity",
      icon: FiMap,
      content: <AdminActivity />,
    },
    {
      value: "audit",
      label: "Audit",
      icon: FiTool,
      content: <AdminAuditLog />,
    },
    {
      value: "audit0",
      label: "Audit",
      icon: FiTool,
      content: <AdminAuditLog />,
    },
    {
      value: "audit1",
      label: "Audit",
      icon: FiTool,
      content: <AdminAuditLog />,
    },
    {
      value: "audit2",
      label: "Audit",
      icon: FiTool,
      content: <AdminAuditLog />,
    },
    {
      value: "audit3",
      label: "Audit",
      icon: FiTool,
      content: <AdminAuditLog />,
    },
    {
      value: "audit4",
      label: "Audit",
      icon: FiTool,
      content: <AdminAuditLog />,
    },
  ];

  const outerTabs: TabItem[] = [
    {
      value: "worker",
      label: "Worker",
      icon: FiUser,
      visible: true,
      content: (
        <ScrollableUnderlineTabs
          tabs={workerTabs}
          defaultValue="equipment"
          edgeMode="overlay"
          edgeSize={16}
          headerPaddingY={2}
        />
      ),
    },
    {
      value: "admin",
      label: "Admin",
      icon: FiSettings,
      visible: () => isAdmin,
      content: (
        <ScrollableUnderlineTabs
          tabs={adminTabs}
          defaultValue="clients"
          edgeMode="overlay"
          edgeSize={16}
          headerPaddingY={2}
        />
      ),
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

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isWorker = hasRole(me?.roles, "WORKER");
  const hasAnyRole = (me?.roles?.length ?? 0) > 0;

  const [topTab, setTopTab] = useState<"worker" | "admin">("worker");
  useEffect(() => {
    if (topTab === "admin" && !isAdmin)
      setTopTab(isWorker ? "worker" : "worker");
    if (topTab === "worker" && !isWorker && isAdmin) setTopTab("admin");
  }, [isAdmin, isWorker, topTab]);

  type AdminTabs = "equipment" | "users" | "activity" | "clients" | "audit";
  const [adminInnerTab, setAdminInnerTab] = useState<AdminTabs>("equipment");

  useEffect(() => {
    // guard: only run in the browser
    if (typeof window === "undefined") return;

    function onOpenEquipmentSearch(e: Event) {
      const { q } = (e as CustomEvent).detail || {};
      if (!q) return;

      setTopTab("admin");
      setAdminInnerTab("equipment");

      // one-shot handoff; no import needed, it's window.sessionStorage
      window.sessionStorage.setItem("admin:equipmentSearchOnce", String(q));
    }

    window.addEventListener(
      "admin:openEquipmentSearch",
      onOpenEquipmentSearch as EventListener
    );
    return () =>
      window.removeEventListener(
        "admin:openEquipmentSearch",
        onOpenEquipmentSearch as EventListener
      );
  }, []);

  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!router.isReady || !isAdmin) return;

    const qAdminTab = String(router.query.adminTab || "");
    const qStatusRaw = String(router.query.status || "");
    if (!qAdminTab) return;

    const key = `${qAdminTab}|${qStatusRaw}`;
    if (appliedKeyRef.current === key) return;

    if (qAdminTab.toLowerCase() === "users") {
      appliedKeyRef.current = key;
      setTopTab("admin");
      setAdminInnerTab("users");

      const status =
        qStatusRaw === "pending" ||
        qStatusRaw === "approved" ||
        qStatusRaw === "all"
          ? (qStatusRaw as "pending" | "approved" | "all")
          : undefined;

      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(
            new CustomEvent("seedlings3:open-users", {
              detail: status ? { status } : undefined,
            })
          );
        } catch {}
      });
    }
  }, [router.isReady, router.query.adminTab, router.query.status, isAdmin]);

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
    const onUsersChanged = () => void loadPending();
    window.addEventListener("seedlings3:users-changed", onUsersChanged);
    return () =>
      window.removeEventListener("seedlings3:users-changed", onUsersChanged);
  }, [loadPending]);

  const goToApprovals = useCallback(() => {
    setTopTab("admin");
    setAdminInnerTab("users");
    router.push(
      { pathname: "/", query: { adminTab: "users", status: "pending" } },
      undefined,
      { shallow: true }
    );
    try {
      window.dispatchEvent(
        new CustomEvent("seedlings3:open-users", {
          detail: { status: "pending" },
        })
      );
    } catch {}
  }, [router]);

  return (
    <Container maxW="5xl" py={8}>
      <AppSplash show={meLoading} />

      <Box
        as="header"
        bg="green.50"
        bgGradient="linear(to-b, var(--chakra-colors-green-50), transparent)"
        borderBottomWidth="1px"
        borderColor="green.100"
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
            {/* Badge FIRST (order 0) */}
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

            {/* Clerk SECOND (order 1) */}
            <Box style={{ order: 1 }} display="flex" alignItems="center">
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
      {!meLoading && me && !me.isApproved && <AwaitingApprovalNotice />}
      {!meLoading && me?.isApproved && !hasAnyRole && <NoRoleNotice />}

      <ScrollableUnderlineTabs
        tabs={outerTabs}
        defaultValue="worker"
        edgeMode="overlay"
        edgeSize={16}
        headerPaddingY={2}
      />
    </Container>
  );
}
