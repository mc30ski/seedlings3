import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Box,
  Heading,
  Stack,
  Text,
  Button,
  Badge,
  HStack,
  Spinner,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "../lib/api";
import { apiDelete } from "../lib/api";
import { toaster } from "./ui/toaster";
import { getErrorMessage } from "../lib/errors";

type Role = "ADMIN" | "WORKER";

type UserRow = {
  id: string;
  isApproved: boolean;
  roles: Role[];
  email?: string | null;
  displayName?: string | null;
};

export default function AdminUsers() {
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "APPROVED">("ALL");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // fetch all; server supports ?approved= param but client-side filter keeps UI snappy
      const data = await apiGet<UserRow[]>("/api/v1/users");
      setItems(data);
    } catch (e) {
      toaster.error({
        title: "Failed to load users",
        description: getErrorMessage(e),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (filter === "ALL") return items;
    if (filter === "PENDING") return items.filter((i) => !i.isApproved);
    return items.filter((i) => i.isApproved);
  }, [items, filter]);

  async function approve(userId: string) {
    setBusy(userId);
    try {
      await apiPost(`/api/v1/users/${userId}/approve`);
      toaster.success({ title: "User approved" });
      await load();
    } catch (e) {
      toaster.error({
        title: "Approve failed",
        description: getErrorMessage(e),
      });
    } finally {
      setBusy(null);
    }
  }

  async function addRole(userId: string, role: Role) {
    setBusy(userId);
    try {
      await apiPost(`/api/v1/users/${userId}/roles`, { role });
      toaster.success({ title: `Role ${role} added` });
      await load();
    } catch (e) {
      toaster.error({
        title: "Add role failed",
        description: getErrorMessage(e),
      });
    } finally {
      setBusy(null);
    }
  }

  async function removeRole(userId: string, role: Role) {
    setBusy(userId);
    try {
      await apiDelete(`/api/v1/users/${userId}/roles/${role}`);
      toaster.success({ title: `Role ${role} removed` });
      await load();
    } catch (e) {
      toaster.error({
        title: "Remove role failed",
        description: getErrorMessage(e),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Box>
      <HStack justify="space-between" mb={3}>
        <Heading size="md">Users</Heading>
        <HStack gap="2">
          <Button
            size="sm"
            variant={filter === "ALL" ? "solid" : "outline"}
            onClick={() => setFilter("ALL")}
          >
            All
          </Button>
          <Button
            size="sm"
            variant={filter === "PENDING" ? "solid" : "outline"}
            onClick={() => setFilter("PENDING")}
          >
            Pending
          </Button>
          <Button
            size="sm"
            variant={filter === "APPROVED" ? "solid" : "outline"}
            onClick={() => setFilter("APPROVED")}
          >
            Approved
          </Button>
        </HStack>
      </HStack>

      {loading && (
        <Box
          minH="160px"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Spinner size="lg" />
        </Box>
      )}

      {!loading && rows.length === 0 && <Text>No users.</Text>}

      <Stack gap="3">
        {!loading &&
          rows.map((u) => {
            const isAdmin = u.roles.includes("ADMIN");
            const isWorker = u.roles.includes("WORKER");
            return (
              <Box key={u.id} p={4} borderWidth="1px" borderRadius="lg">
                <Heading size="sm">
                  {u.displayName || u.email || u.id.slice(0, 8)}{" "}
                  <Badge
                    ml={2}
                    colorPalette={u.isApproved ? "green" : "orange"}
                  >
                    {u.isApproved ? "Approved" : "Pending"}
                  </Badge>
                </Heading>
                {u.email && (
                  <Text fontSize="xs" color="gray.600">
                    {u.email}
                  </Text>
                )}
                <HStack mt={2} gap="2">
                  {/* Approval */}
                  {!u.isApproved && (
                    <Button
                      size="sm"
                      onClick={() => approve(u.id)}
                      loading={busy === u.id}
                    >
                      Approve
                    </Button>
                  )}

                  {/* Roles */}
                  {!isWorker && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => addRole(u.id, "WORKER")}
                      loading={busy === u.id}
                    >
                      Add Worker
                    </Button>
                  )}
                  {isWorker && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => removeRole(u.id, "WORKER")}
                      loading={busy === u.id}
                    >
                      Remove Worker
                    </Button>
                  )}

                  {!isAdmin && (
                    <Button
                      size="sm"
                      colorPalette="purple"
                      onClick={() => addRole(u.id, "ADMIN")}
                      loading={busy === u.id}
                    >
                      Promote to Admin
                    </Button>
                  )}
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="purple"
                      onClick={() => removeRole(u.id, "ADMIN")}
                      loading={busy === u.id}
                    >
                      Demote Admin
                    </Button>
                  )}
                </HStack>
              </Box>
            );
          })}
      </Stack>
    </Box>
  );
}
