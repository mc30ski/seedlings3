import { useEffect, useState, useCallback } from "react";
import { Container, Heading, Box, Text, Tabs } from "@chakra-ui/react";
import WorkerEquipment from "../src/components/WorkerEquipment";
import WorkerMyEquipment from "../src/components/WorkerMyEquipment";
import AdminEquipment from "../src/components/AdminEquipment";
import AdminAuditLog from "../src/components/AdminAuditLog";
import DevRoleSwitch from "../src/components/DevRoleSwitch";
import { apiGet } from "../src/lib/api";
import { effectiveRoleGuards } from "../src/lib/devRole";

type Me = {
  id: string;
  isApproved: boolean;
  roles: ("ADMIN" | "WORKER")[];
  email?: string | null;
  displayName?: string | null;
};

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  // Fetch /me (used on mount and when dev-role/prod toggle changes)
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

  // Re-fetch /me when the dev role or prod-mode toggle changes
  useEffect(() => {
    const onChange = () => void loadMe();
    window.addEventListener("seedlings3:dev-role-changed", onChange);
    return () =>
      window.removeEventListener("seedlings3:dev-role-changed", onChange);
  }, [loadMe]);

  const { isAdmin, isWorker } = effectiveRoleGuards(me?.roles);

  // Top-level tab (worker/admin). Start on worker; keep it valid as roles change.
  const [topTab, setTopTab] = useState<"worker" | "admin">("worker");
  useEffect(() => {
    // If current tab is no longer allowed, switch to the allowed one.
    if (topTab === "admin" && !isAdmin)
      setTopTab(isWorker ? "worker" : "worker");
    if (topTab === "worker" && !isWorker && isAdmin) setTopTab("admin");
  }, [isAdmin, isWorker, topTab]);

  return (
    <Container maxW="5xl" py={8}>
      <Heading mb={4}>Seedlings Lawn Care</Heading>

      {/* Dev tools (role switch + prod-mode toggle) */}
      <Box mb={4}>
        <DevRoleSwitch />
      </Box>

      {/* Lightweight loading indicator while /me resolves */}
      {meLoading && <Text mb={3}>Loading…</Text>}

      {/* Real user state (optional) */}
      {!meLoading && me && !me.isApproved && (
        <Text color="red.500" mb={3}>
          Awaiting admin approval…
        </Text>
      )}

      {/* Main tabs only when we know roles and user is approved */}
      {!meLoading && (isWorker || isAdmin) && me?.isApproved && (
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

          {/* Worker area (nested tabs, ready for future sections) */}
          {isWorker && (
            <Tabs.Content value="worker">
              <Tabs.Root defaultValue="equipment" lazyMount unmountOnExit>
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  <Tabs.Trigger value="mine">My Equipment</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  <WorkerEquipment />
                </Tabs.Content>

                <Tabs.Content value="mine">
                  {/* NEW: only items the current user has checked out */}
                  <WorkerMyEquipment />
                </Tabs.Content>
              </Tabs.Root>
            </Tabs.Content>
          )}

          {/* Admin area (nested tabs) */}
          {isAdmin && (
            <Tabs.Content value="admin">
              <Tabs.Root defaultValue="equipment" lazyMount unmountOnExit>
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  <Tabs.Trigger value="audit">Audit Log</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  {/* Fresh mount when switching into Admin tab */}
                  <AdminEquipment key={`admin-${topTab}`} />
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
