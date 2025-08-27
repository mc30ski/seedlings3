import { useEffect, useState } from "react";
import { Container, Heading, Box, Text, Tabs } from "@chakra-ui/react";
import WorkerEquipment from "../src/components/WorkerEquipment";
import AdminEquipment from "../src/components/AdminEquipment";
import AdminAuditLog from "../src/components/AdminAuditLog";
import DevRoleSwitch from "../src/components/DevRoleSwitch"; // remove if you don't use this
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

  useEffect(() => {
    apiGet<Me>("/api/v1/me")
      .then((res) => setMe(res))
      .catch(() => setMe(null));
  }, []);

  const isWorker = !!me?.roles?.includes("WORKER");
  const isAdmin = !!me?.roles?.includes("ADMIN");
  const defaultTopTab = isWorker ? "worker" : isAdmin ? "admin" : "worker";

  return (
    <Container maxW="5xl" py={8}>
      <Heading mb={4}>Seedlings Lawn Care</Heading>

      {/* Dev-only: mock user switcher (remove if not needed) */}
      <Box mb={4}>
        <DevRoleSwitch />
      </Box>

      {!me && (
        <Text color="orange.500" mb={3}>
          Not signed in (DEV mock). Pick a DEV user above.
        </Text>
      )}
      {me && !me.isApproved && (
        <Text color="red.500" mb={3}>
          Awaiting admin approval…
        </Text>
      )}

      {(isWorker || isAdmin) && me?.isApproved && (
        <Tabs.Root defaultValue={defaultTopTab}>
          <Tabs.List mb={4}>
            {isWorker && <Tabs.Trigger value="worker">Worker</Tabs.Trigger>}
            {isAdmin && <Tabs.Trigger value="admin">Admin</Tabs.Trigger>}
          </Tabs.List>

          {isWorker && (
            <Tabs.Content value="worker">
              <WorkerEquipment />
            </Tabs.Content>
          )}

          {isAdmin && (
            <Tabs.Content value="admin">
              {/* Nested tabs for Admin sections */}
              <Tabs.Root defaultValue="equipment">
                <Tabs.List mb={4}>
                  <Tabs.Trigger value="equipment">Equipment</Tabs.Trigger>
                  <Tabs.Trigger value="audit">Audit Log</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="equipment">
                  <AdminEquipment />
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
