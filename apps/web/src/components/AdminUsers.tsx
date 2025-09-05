import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Heading,
  HStack,
  Stack,
  Text,
  Badge,
  Input,
  Spinner,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete } from "../lib/api";
import { toaster } from "./ui/toaster";
import { getErrorMessage } from "../lib/errors";

type Role = "ADMIN" | "WORKER";
type ApiUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  isApproved: boolean;
  roles: { role: Role }[];
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

export default function AdminUsers() {
  const [items, setItems] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);

  // filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "pending" | "approved">("all");
  const [role, setRole] = useState<"all" | "worker" | "admin">("all");

  const rolesSet = (u: ApiUser) => new Set(u.roles.map((r) => r.role));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status === "pending") params.set("approved", "false");
      if (status === "approved") params.set("approved", "true");
      if (role === "worker") params.set("role", "WORKER");
      if (role === "admin") params.set("role", "ADMIN");

      const data = await apiGet<ApiUser[]>(
        `/api/v1/admin/users${params.toString() ? `?${params}` : ""}`
      );
      setItems(data);
    } catch (err) {
      toaster.error({
        title: "Failed to load users",
        description: getErrorMessage(err),
      });
    } finally {
      setLoading(false);
    }
  }, [status, role]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const qlc = q.trim().toLowerCase();
    if (!qlc) return items;
    return items.filter((u) => {
      const name = (u.displayName ?? "").toLowerCase();
      const email = (u.email ?? "").toLowerCase();
      return name.includes(qlc) || email.includes(qlc) || u.id.includes(qlc);
    });
  }, [items, q]);

  async function approve(userId: string) {
    try {
      await apiPost(`/api/v1/admin/users/${userId}/approve`);
      toaster.success({ title: "User approved" });
      await load();
    } catch (err) {
      toaster.error({
        title: "Approve failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function addRole(userId: string, role: Role) {
    try {
      await apiPost(`/api/v1/admin/users/${userId}/roles`, { role });
      // Policy: Admins should also be Workers
      if (role === "ADMIN") {
        try {
          await apiPost(`/api/v1/admin/users/${userId}/roles`, {
            role: "WORKER",
          });
        } catch {}
      }
      toaster.success({ title: `Added ${role}` });
      await load();
    } catch (err) {
      toaster.error({
        title: "Add role failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function removeRole(userId: string, role: Role) {
    try {
      await apiDelete(`/api/v1/admin/users/${userId}/roles/${role}`);
      toaster.success({ title: `Removed ${role}` });
      await load();
    } catch (err) {
      toaster.error({
        title: "Remove role failed",
        description: getErrorMessage(err),
      });
    }
  }

  // NEW: hard-delete user (DB + Clerk)
  async function removeUserHard(u: ApiUser) {
    const label = u.displayName || u.email || u.id.slice(0, 8);
    if (
      !confirm(
        `Remove ${label}? This will permanently delete their account and revoke access.`
      )
    )
      return;

    try {
      const res = await apiDelete<{ deleted: true; clerkDeleted: boolean }>(
        `/api/v1/admin/users/${u.id}`
      );
      toaster.success({
        title: "User removed",
        description: res?.clerkDeleted
          ? "Deleted from Clerk and database."
          : "Deleted from database. (Clerk user was already missing or could not be deleted.)",
      });
      await load();
    } catch (err) {
      toaster.error({
        title: "Remove user failed",
        description: getErrorMessage(err),
      });
    }
  }

  return (
    <Box>
      <Heading size="md" mb={4}>
        Users & Access
      </Heading>

      {/* Filters */}
      <Stack gap="3" mb={4}>
        <HStack gap="3" wrap="wrap">
          <HStack gap="2">
            <Text fontSize="sm" color="gray.600">
              Status:
            </Text>
            <HStack gap="1">
              <Button
                size="sm"
                variant={status === "all" ? "solid" : "outline"}
                onClick={() => setStatus("all")}
              >
                All
              </Button>
              <Button
                size="sm"
                variant={status === "pending" ? "solid" : "outline"}
                onClick={() => setStatus("pending")}
              >
                Pending
              </Button>
              <Button
                size="sm"
                variant={status === "approved" ? "solid" : "outline"}
                onClick={() => setStatus("approved")}
              >
                Approved
              </Button>
            </HStack>
          </HStack>

          <HStack gap="2">
            <Text fontSize="sm" color="gray.600">
              Role:
            </Text>
            <HStack gap="1">
              <Button
                size="sm"
                variant={role === "all" ? "solid" : "outline"}
                onClick={() => setRole("all")}
              >
                All
              </Button>
              <Button
                size="sm"
                variant={role === "worker" ? "solid" : "outline"}
                onClick={() => setRole("worker")}
              >
                Worker
              </Button>
              <Button
                size="sm"
                variant={role === "admin" ? "solid" : "outline"}
                onClick={() => setRole("admin")}
              >
                Admin
              </Button>
            </HStack>
          </HStack>

          <Input
            placeholder="Search name/email/user id…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxW="320px"
            ml="auto"
          />
        </HStack>
      </Stack>

      {/* List */}
      {loading && <LoadingCenter />}

      {!loading && filtered.length === 0 && (
        <Text>No users match the current filters.</Text>
      )}

      {!loading &&
        filtered.map((u) => {
          const s = rolesSet(u);
          const isAdmin = s.has("ADMIN");
          const isWorker = s.has("WORKER");

          return (
            <Box key={u.id} p={4} borderWidth="1px" borderRadius="lg" mb={3}>
              <HStack justify="space-between" align="start">
                <Box>
                  <Heading size="sm">
                    {u.displayName || u.email || "(no name)"}
                  </Heading>
                  <Text fontSize="xs" color="gray.600">
                    {u.email || "—"} · id: {u.id.slice(0, 8)}…
                  </Text>
                  <HStack gap="2" mt={2}>
                    <Badge>{u.isApproved ? "Approved" : "Pending"}</Badge>
                    {isWorker && <Badge colorPalette="blue">Worker</Badge>}
                    {isAdmin && <Badge colorPalette="purple">Admin</Badge>}
                  </HStack>
                </Box>

                <Stack direction="row" gap="2">
                  {!u.isApproved ? (
                    <Button size="sm" onClick={() => approve(u.id)}>
                      Approve
                    </Button>
                  ) : null}

                  {/* Admin toggle */}
                  {isAdmin ? (
                    <Button
                      size="sm"
                      onClick={() => removeRole(u.id, "ADMIN")}
                      variant="subtle"
                    >
                      Remove Admin
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => addRole(u.id, "ADMIN")}
                      variant="subtle"
                    >
                      Make Admin
                    </Button>
                  )}

                  {/* Worker control:
                     - If Admin: keep the old "Remove Worker" (disabled) message.
                     - If NOT Admin and is Worker: "Remove Worker" now HARD-DELETES user (DB + Clerk).
                     - If not Worker: allow "Add Worker".
                  */}
                  {isWorker ? (
                    isAdmin ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        title="Admins must keep Worker role — demote from Admin first"
                      >
                        Remove Worker
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="red"
                        onClick={() => removeUserHard(u)}
                        title="Delete this user from Clerk and the database"
                      >
                        Remove Worker
                      </Button>
                    )
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => addRole(u.id, "WORKER")}
                      variant="outline"
                    >
                      Add Worker
                    </Button>
                  )}
                </Stack>
              </HStack>
            </Box>
          );
        })}
    </Box>
  );
}
