import { useEffect, useState } from "react";
import { Container, Heading, Box, Text, Tabs } from "@chakra-ui/react";
import WorkerEquipment from "../src/components/WorkerEquipment";
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

  useEffect(() => {
    apiGet<Me>("/api/v1/me")
      .then((res) => setMe(res))
      .catch(() => setMe(null));
  }, []);

  const [, force] = useState(0);
  useEffect(() => {
    const onChange = () => force((n) => n + 1);
    window.addEventListener("seedlings3:dev-role-changed", onChange);
    return () =>
      window.removeEventListener("seedlings3:dev-role-changed", onChange);
  }, []);

  const { isAdmin, isWorker } = effectiveRoleGuards(me?.roles);
  const defaultTopTab = isWorker ? "worker" : isAdmin ? "admin" : "worker";

  // at top of the page component
  const [topTab, setTopTab] = useState<"worker" | "admin">(
    (defaultTopTab as "worker" | "admin") ?? "worker"
  );

  return (
    <Container maxW="5xl" py={8}>
      <Heading mb={4}>Seedlings Lawn Care</Heading>

      {/* Dev-only: mock user switcher (remove if not needed) */}
      <Box mb={4}>
        <DevRoleSwitch />
      </Box>

      {me && !me.isApproved && (
        <Text color="red.500" mb={3}>
          Awaiting admin approval…
        </Text>
      )}

      {(isWorker || isAdmin) && me?.isApproved && (
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
                  {/* Future: add more Worker tabs here */}
                </Tabs.List>

                <Tabs.Content value="equipment">
                  <WorkerEquipment />
                </Tabs.Content>
              </Tabs.Root>
            </Tabs.Content>
          )}

          {isAdmin && (
            <Tabs.Content value="admin">
              <Tabs.Root defaultValue="equipment" lazyMount unmountOnExit>
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  <Tabs.Trigger value="audit">Audit Log</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  {/* force a fresh mount whenever you switch into admin */}
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
