"use client";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Box, Container, HStack } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import BrandLabel from "@/src/ui/helpers/BrandLabel";
import { useRouter } from "next/router";
import { UserButton } from "@clerk/clerk-react";

import WorkerEquipment from "@/src/ui/tabs/WorkerEquipment";

import AdminEquipment from "@/src/ui/tabs/AdminEquipment";
import AdminUsers from "@/src/ui/tabs/AdminUsers";
import AdminActivity from "@/src/ui/tabs/AdminActivity";
import AdminAuditLog from "@/src/ui/tabs/AdminAuditLog";

import Jobs from "@/src/ui/tabs/Jobs";
import Clients from "@/src/ui/tabs/Clients";
import Properties from "@/src/ui/tabs/Properties";

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
  FiFileText,
  FiMapPin,
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

  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isWorker = hasRole(me?.roles, "WORKER");
  const hasAnyRole = (me?.roles?.length ?? 0) > 0;

  const [topTab, setTopTab] = useState<"worker" | "admin">("worker");

  type AdminTabs = "equipment" | "users" | "activity" | "clients" | "audit";
  const [adminInnerTab, setAdminInnerTab] = useState<AdminTabs>("equipment");

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

  useEffect(() => {
    if (topTab === "admin" && !isAdmin)
      setTopTab(isWorker ? "worker" : "worker");
    if (topTab === "worker" && !isWorker && isAdmin) setTopTab("admin");
  }, [isAdmin, isWorker, topTab]);

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
      content: <Jobs />,
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
    { value: "clients", label: "Clients", icon: FiUser, content: <Clients /> },
    {
      value: "properties",
      label: "Properties",
      icon: FiMapPin,
      content: <Properties />,
    },
    {
      value: "jobs",
      label: "Jobs",
      icon: FiBriefcase,
      content: <Jobs />,
    },
    {
      value: "audit",
      label: "Audit",
      icon: FiFileText,
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
          unmountOnExit
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
          value={adminInnerTab}
          onValueChange={(v) => setAdminInnerTab(v as AdminTabs)}
          edgeMode="overlay"
          edgeSize={16}
          headerPaddingY={2}
          unmountOnExit
        />
      ),
    },
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpenEquipmentSearch = (e: Event) => {
      const { q } = (e as CustomEvent).detail || {};
      if (!q) return;
      setTopTab("admin");
      setAdminInnerTab("equipment");
      window.sessionStorage.setItem("admin:equipmentSearchOnce", String(q));
    };
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (topTab !== "admin" || adminInnerTab !== "equipment") return;
    const key = "admin:equipmentSearchOnce";
    const q = window.sessionStorage.getItem(key);
    if (!q) return;
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("equipmentSearch:run", { detail: { q } })
      );
      window.sessionStorage.removeItem(key);
    });
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
    const onUsersChanged = () => void loadPending();
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
      {me?.isApproved && hasAnyRole && (
        <ScrollableUnderlineTabs
          tabs={outerTabs}
          value={topTab}
          onValueChange={(v) => setTopTab(v as typeof topTab)}
          edgeMode="overlay"
          edgeSize={16}
          headerPaddingY={2}
          unmountOnExit
        />
      )}
    </Container>
  );
}
