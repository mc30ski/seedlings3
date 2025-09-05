import { useEffect, useState, useCallback } from "react";
import { Container, Heading, Text, Tabs } from "@chakra-ui/react";
import WorkerEquipment from "../src/components/WorkerEquipment";
import WorkerMyEquipment from "../src/components/WorkerMyEquipment";
import AdminEquipment from "../src/components/AdminEquipment";
import AdminAuditLog from "../src/components/AdminAuditLog";
import AdminUsers from "../src/components/AdminUsers";
import { apiGet } from "../src/lib/api";

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

  const roles = me?.roles ?? [];
  const isAdmin = roles.includes("ADMIN");
  const isWorker = roles.includes("WORKER");

  const [topTab, setTopTab] = useState<"worker" | "admin">("worker");
  useEffect(() => {
    if (topTab === "admin" && !isAdmin)
      setTopTab(isWorker ? "worker" : "worker");
    if (topTab === "worker" && !isWorker && isAdmin) setTopTab("admin");
  }, [isAdmin, isWorker, topTab]);

  return (
    <Container maxW="5xl" py={8}>
      <Heading mb={4}>Seedlings Lawn Care</Heading>

      {meLoading && <Text mb={3}>Loading…</Text>}

      {!meLoading && me && !me.isApproved && (
        <Text color="red.500" mb={3}>
          Awaiting admin approval…
        </Text>
      )}

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
                  <WorkerMyEquipment />
                </Tabs.Content>
              </Tabs.Root>
            </Tabs.Content>
          )}

          {isAdmin && (
            <Tabs.Content value="admin">
              <Tabs.Root defaultValue="equipment" lazyMount unmountOnExit>
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  {/* Users now comes before Audit Log */}
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
