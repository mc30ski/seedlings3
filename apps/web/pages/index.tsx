import { useEffect, useState, useCallback, useRef } from "react";
import { Container, Box, Text, Spinner, Tabs, HStack } from "@chakra-ui/react";
import WorkerEquipment from "../src/components/WorkerEquipment";
import WorkerMyEquipment from "../src/components/WorkerMyEquipment";
import AdminEquipment from "../src/components/AdminEquipment";
import AdminAuditLog from "../src/components/AdminAuditLog";
import AdminUsers from "../src/components/AdminUsers";
import { apiGet } from "../src/lib/api";
import WorkerUnavailable from "../src/components/WorkerUnavailable";
import BrandLabel from "../src/components/BrandLabel";
import AdminApprovalBell from "../src/components/AdminApprovalBell";
import { useRouter } from "next/router";

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
      const data = await apiGet<Me>("/api/v1/me");
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
    "equipment" | "users" | "audit"
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

      // Tell AdminUsers to set its Status filter (uses your existing listener)
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

  return (
    <Container maxW="5xl" py={8}>
      {/* Header: brand on the left, approvals bell on the right */}
      <HStack justify="space-between" align="center" mb={2}>
        <BrandLabel size={26} showText />
        <AdminApprovalBell />
      </HStack>
      TEST3
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
              </Tabs.Root>
            </Tabs.Content>
          )}

          {isAdmin && (
            <Tabs.Content value="admin">
              <Tabs.Root
                value={adminInnerTab}
                onValueChange={(d) =>
                  setAdminInnerTab(d.value as "equipment" | "users" | "audit")
                }
                lazyMount
                unmountOnExit
              >
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  <Tabs.Trigger value="users">Users</Tabs.Trigger>
                  <Tabs.Trigger value="audit">Audit Log</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  <AdminEquipment key={`admin-${topTab}`} />
                </Tabs.Content>

                <Tabs.Content value="users">
                  <AdminUsers />
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
