"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { Box, Container, Text, Spinner, Tabs, HStack } from "@chakra-ui/react";
import WorkerEquipment from "../src/components/WorkerEquipment";
import WorkerMyEquipment from "../src/components/WorkerMyEquipment";
import AdminEquipment from "../src/components/AdminEquipment";
import AdminAuditLog from "../src/components/AdminAuditLog";
import AdminUsers from "../src/components/AdminUsers";
import { apiGet } from "../src/lib/api";
import WorkerUnavailable from "../src/components/WorkerUnavailable";
import BrandLabel from "../src/components/BrandLabel";
import { useRouter } from "next/router";
import { UserButton } from "@clerk/clerk-react";
import AdminActivity from "../src/components/AdminActivity";
import WorkerAllEquipment from "../src/components/WorkerAllEquipment";

type Me = {
  id: string;
  isApproved: boolean;
  roles: ("ADMIN" | "WORKER")[];
  email?: string | null;
  displayName?: string | null;
};

const hasRole = (roles: Me["roles"] | undefined, role: "ADMIN" | "WORKER") =>
  !!roles?.includes(role);

export default function HomePage() {
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [meLoading, setMeLoading] = useState(true);

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

  // Control inner Admin tab so we can deep-link to Users
  const [adminInnerTab, setAdminInnerTab] = useState<
    "equipment" | "users" | "activity" | "audit"
  >("equipment");

  // Apply deep-link (?adminTab=users&status=pending) when ready
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

  // Header sizing baseline
  const BRAND_ICON_H = 26; // px

  // De-dup the Clerk button robustly: hide OUR header button if ANY other Clerk user button exists
  const headerBtnRef = useRef<HTMLDivElement | null>(null);
  const [showLocalUserBtn, setShowLocalUserBtn] = useState(false); // start hidden to avoid flash
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
      // true if any node exists that is NOT inside our header container
      return nodes.some((n) => !isInsideHeader(n));
    };

    const raf = requestAnimationFrame(() => {
      setShowLocalUserBtn(!hasExternalClerkButton());
    });

    // Observe DOM changes (Clerk mounts asynchronously)
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

  return (
    <Container maxW="5xl" py={8}>
      {/* Brand header with subtle Seedlings green wash */}
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
        {/* GRID: left brand, right Clerk. This forces right flush + exact vertical centering */}
        <Box
          display="grid"
          gridTemplateColumns="1fr auto"
          alignItems="center"
          columnGap={3}
          minH={`${BRAND_ICON_H}px`}
        >
          {/* Left: brand (keep your +1px nudge for optical match) */}
          <Box
            display="flex"
            alignItems="center"
            lineHeight="0"
            style={{ transform: "translateY(1px)" }}
          >
            <BrandLabel size={BRAND_ICON_H} showText />
          </Box>

          {/* Right: Clerk pinned to far right and centered */}
          <Box
            ref={headerBtnRef}
            justifySelf="end"
            alignSelf="center"
            display="grid"
            placeItems="center"
            lineHeight="0"
            minH={`${BRAND_ICON_H}px`}
          >
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
        </Box>
      </Box>

      {meLoading && (
        <Box mb={4} display="flex" alignItems="center" gap="2">
          <Spinner size="sm" />
          <Text>Loading…</Text>
        </Box>
      )}

      {!meLoading && me && !me.isApproved && (
        <Text color="red.500" mb={3}>
          Awaiting admin approval…
        </Text>
      )}

      {!meLoading && me?.isApproved && !hasAnyRole && (
        <Text color="orange.500" mb={3}>
          You have been approved, but don&apos;t have a role yet. Please contact
          your Administrator.
        </Text>
      )}

      {!meLoading && me?.isApproved && hasAnyRole && (
        <Tabs.Root
          value={topTab}
          onValueChange={(d) => setTopTab(d.value as "worker" | "admin")}
          lazyMount
          unmountOnExit
        >
          <Tabs.List mb={4}>
            {isWorker && <Tabs.Trigger value="worker">Worker</Tabs.Trigger>}
            {isAdmin && <Tabs.Trigger value="admin">Admin</Tabs.Trigger>}
          </Tabs.List>

          {isWorker && (
            <Tabs.Content value="worker">
              <Tabs.Root defaultValue="equipment" lazyMount unmountOnExit>
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="mine">Claimed</Tabs.Trigger>
                  <Tabs.Trigger value="equipment">Available</Tabs.Trigger>
                  <Tabs.Trigger value="unavailable">Unavailable</Tabs.Trigger>
                  <Tabs.Trigger value="all">All</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  <WorkerEquipment />
                </Tabs.Content>

                <Tabs.Content value="mine">
                  <WorkerMyEquipment />
                </Tabs.Content>

                <Tabs.Content value="unavailable">
                  <WorkerUnavailable />
                </Tabs.Content>

                <Tabs.Content value="all">
                  <WorkerAllEquipment />
                </Tabs.Content>
              </Tabs.Root>
            </Tabs.Content>
          )}

          {isAdmin && (
            <Tabs.Content value="admin">
              <Tabs.Root
                value={adminInnerTab}
                onValueChange={(d) =>
                  setAdminInnerTab(
                    d.value as "equipment" | "users" | "activity" | "audit"
                  )
                }
                lazyMount
                unmountOnExit
              >
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  <Tabs.Trigger value="users">Users</Tabs.Trigger>
                  <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
                  <Tabs.Trigger value="audit">Audit</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  <AdminEquipment />
                </Tabs.Content>

                <Tabs.Content value="users">
                  <AdminUsers />
                </Tabs.Content>

                <Tabs.Content value="activity">
                  <AdminActivity />
                </Tabs.Content>

                <Tabs.Content value="audit">
                  <AdminAuditLog />
                </Tabs.Content>
              </Tabs.Root>
            </Tabs.Content>
          )}
        </Tabs.Root>
      )}
    </Container>
  );
}
