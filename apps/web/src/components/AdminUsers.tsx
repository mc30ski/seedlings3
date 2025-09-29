// apps/web/src/components/AdminUsers.tsx
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

type Me = {
  id: string;
  isApproved: boolean;
  roles: ("ADMIN" | "WORKER")[];
  email?: string | null;
  displayName?: string | null;
};

type Holding = {
  userId: string;
  equipmentId: string;
  shortDesc: string;
  brand?: string | null;
  model?: string | null;
  state: "RESERVED" | "CHECKED_OUT";
  reservedAt: string; // ISO
  checkedOutAt: string | null; // ISO
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

// Inline confirm state
type ConfirmKind = "delete" | "decline";
type ConfirmState = { userId: string; kind: ConfirmKind } | null;

// --- helper to read initial status from URL (so deep links work on first paint)
function initialStatusFromUrl(): "all" | "pending" | "approved" {
  if (typeof window === "undefined") return "all";
  try {
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get("status");
    if (s === "pending" || s === "approved" || s === "all") return s;
  } catch {}
  return "all";
}

export default function AdminUsers() {
  const [items, setItems] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);

  // who am I? (used to hide actions for self)
  const [me, setMe] = useState<Me | null>(null);
  const [meReady, setMeReady] = useState(false); // prevents action button flash

  // simple filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "pending" | "approved">(
    initialStatusFromUrl
  ); // <- init from URL
  const [role, setRole] = useState<"all" | "worker" | "admin">("all");

  // inline warning by user id (shown under their info)
  const [inlineErr, setInlineErr] = useState<Record<string, string>>({});

  // current holdings map (userId -> Holding[])
  const [holdingsByUser, setHoldingsByUser] = useState<
    Record<string, Holding[]>
  >({});

  // NEW: confirm inline bar state (for Delete or Decline)
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // react to request to open "pending" (from the header bell)
  useEffect(() => {
    const onOpenUsers = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { status?: "pending" | "approved" | "all" }
        | undefined;
      if (detail?.status) setStatus(detail.status);
    };
    window.addEventListener(
      "seedlings3:open-users",
      onOpenUsers as EventListener
    );
    return () =>
      window.removeEventListener(
        "seedlings3:open-users",
        onOpenUsers as EventListener
      );
  }, []);

  // Also react to a status change in the URL after mount (e.g., client nav)
  useEffect(() => {
    const onPop = () => {
      try {
        const sp = new URLSearchParams(window.location.search);
        const s = sp.get("status");
        if (s === "pending" || s === "approved" || s === "all") {
          setStatus(s);
        }
      } catch {}
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Load "me" and set meReady when done (success or fail)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await apiGet<Me>("/api/me");
        if (!cancelled) setMe(m);
      } catch {
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setMeReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rolesSet = (u: ApiUser) => new Set(u.roles.map((r) => r.role));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Build users params
      const params = new URLSearchParams();
      if (status === "pending") params.set("approved", "false");
      if (status === "approved") params.set("approved", "true");
      if (role === "worker") params.set("role", "WORKER");
      if (role === "admin") params.set("role", "ADMIN");

      // Load users + holdings together (holdings is a separate endpoint)
      const [users, holdings] = await Promise.all([
        apiGet<ApiUser[]>(
          `/api/admin/users${params.toString() ? `?${params}` : ""}`
        ),
        apiGet<Holding[]>(`/api/admin/holdings`),
      ]);

      setItems(users);

      // group holdings by userId for quick lookup
      const map: Record<string, Holding[]> = {};
      for (const h of holdings) {
        if (!map[h.userId]) map[h.userId] = [];
        map[h.userId].push(h);
      }
      setHoldingsByUser(map);

      // clear any stale inline warnings + confirm bar after refresh
      setInlineErr({});
      setConfirm(null);
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
      // Removed user-id searching from filter
      return name.includes(qlc) || email.includes(qlc);
    });
  }, [items, q]);

  async function approve(userId: string) {
    try {
      await apiPost(`/api/admin/users/${userId}/approve`);
      toaster.success({ title: "User approved" });
      try {
        window.dispatchEvent(new Event("seedlings3:users-changed"));
      } catch {}
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
      await apiPost(`/api/admin/users/${userId}/roles`, { role });
      if (role === "ADMIN") {
        try {
          await apiPost(`/api/admin/users/${userId}/roles`, {
            role: "WORKER",
          });
        } catch {}
      }
      toaster.success({ title: `Added ${role}` });
      // clear any warning for this user (role changed)
      setInlineErr((m) => {
        const n = { ...m };
        delete n[userId];
        return n;
      });
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
      await apiDelete(`/api/admin/users/${userId}/roles/${role}`);
      toaster.success({ title: `Removed ${role}` });
      // clear any warning for this user on success
      setInlineErr((m) => {
        const n = { ...m };
        delete n[userId];
        return n;
      });
      await load();
    } catch (err: any) {
      // Detect a 409 regardless of fetch wrapper
      const status =
        err?.status ??
        err?.httpStatus ??
        err?.response?.status ??
        (/\b409\b/.test(String(err)) ? 409 : undefined);

      const msg =
        status === 409
          ? "This user currently has reserved/checked-out equipment. Release all items before removing the Worker role."
          : getErrorMessage(err);

      setInlineErr((prev) => ({ ...prev, [userId]: msg }));
      // also toast (useful if the row is out of view)
      toaster.error({ title: "Remove role failed", description: msg });
    }
  }

  // Hard delete (DB + Clerk) — used for both Delete and Decline confirmations
  async function deleteUser(userId: string) {
    try {
      await apiDelete(`/api/admin/users/${userId}`);
      toaster.success({ title: "User removed" });
      await load();
    } catch (err) {
      const msg = getErrorMessage(err);
      setInlineErr((prev) => ({ ...prev, [userId]: msg }));
      toaster.error({ title: "Remove failed", description: msg });
    }
  }

  const dismissInline = (userId: string) =>
    setInlineErr((m) => {
      const n = { ...m };
      delete n[userId];
      return n;
    });

  return (
    <Box w="full">
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
            placeholder="Search name or email…"
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
          const hasAnyRole = isAdmin || isWorker;
          const isMe = !!me?.id && u.id === me.id;
          const holdings = holdingsByUser[u.id] ?? [];

          const showDelete = u.isApproved && !hasAnyRole && !isMe;
          const showDecline = !u.isApproved && !isMe;

          const isConfirming = confirm?.userId === u.id;
          const confirmKind = confirm?.kind;

          // Copy per confirm kind
          const confirmCopy =
            confirmKind === "decline"
              ? "Decline this user? This removes their account and Clerk entry. This action cannot be undone."
              : "Delete this user? This removes their account and Clerk entry. This action cannot be undone.";

          const confirmCTA =
            confirmKind === "decline" ? "Confirm decline" : "Confirm delete";

          return (
            <Box
              key={u.id}
              p={3}
              borderWidth="1px"
              borderRadius="lg"
              mb={3}
              w="full"
            >
              {/* TOP ROW: identity + badges + warning + actions */}
              <Stack
                direction={{ base: "column", md: "row" }}
                align={{ base: "stretch", md: "start" }}
                justify="space-between"
                gap="3"
                w="full"
              >
                {/* LEFT: identity + badges + warning */}
                <Box flex="1 1 0" minW={0}>
                  <Heading size="sm" wordBreak="break-word">
                    {u.displayName || u.email || "(no name)"}{" "}
                    {isMe && <Badge ml="2">You</Badge>}
                  </Heading>
                  <Text fontSize="xs" color="gray.600" wordBreak="break-word">
                    {u.email || "—"}
                  </Text>
                  <HStack gap="2" mt={2} flexWrap="wrap">
                    <Badge>{u.isApproved ? "Approved" : "Pending"}</Badge>
                    {isWorker && <Badge colorPalette="blue">Worker</Badge>}
                    {isAdmin && <Badge colorPalette="purple">Admin</Badge>}
                  </HStack>

                  {/* Inline warnings (role removal, delete errors, etc.) */}
                  {inlineErr[u.id] && (
                    <HStack
                      mt={3}
                      align="start"
                      p={3}
                      borderRadius="md"
                      borderWidth="1px"
                      borderColor="orange.300"
                      bg="orange.50"
                    >
                      <Box flex="1">
                        <Text fontSize="sm" color="orange.900">
                          {inlineErr[u.id]}
                        </Text>
                      </Box>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => dismissInline(u.id)}
                      >
                        Dismiss
                      </Button>
                    </HStack>
                  )}
                </Box>

                {/* RIGHT: actions */}
                {meReady && (
                  <Stack
                    direction="row"
                    gap="2"
                    flexWrap="wrap"
                    justify={{ base: "flex-start", md: "flex-end" }}
                  >
                    {isMe ? null : (
                      <>
                        {!u.isApproved ? (
                          <>
                            <Button
                              size={{ base: "xs", md: "sm" }}
                              onClick={() => approve(u.id)}
                            >
                              Approve
                            </Button>
                            {!isConfirming && showDecline && (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                variant="outline"
                                colorPalette="red"
                                onClick={() =>
                                  setConfirm({ userId: u.id, kind: "decline" })
                                }
                                title="Decline and remove this user"
                              >
                                Decline
                              </Button>
                            )}
                          </>
                        ) : (
                          <>
                            {/* Role toggles */}
                            {isAdmin ? (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => removeRole(u.id, "ADMIN")}
                                variant="subtle"
                              >
                                Remove Admin
                              </Button>
                            ) : (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => addRole(u.id, "ADMIN")}
                                variant="subtle"
                              >
                                Make Admin
                              </Button>
                            )}

                            {isWorker ? (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => removeRole(u.id, "WORKER")}
                                variant="outline"
                                disabled={isAdmin}
                                title={
                                  isAdmin ? "Admins must keep Worker role" : ""
                                }
                              >
                                Remove Worker
                              </Button>
                            ) : (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => addRole(u.id, "WORKER")}
                                variant="outline"
                              >
                                Add Worker
                              </Button>
                            )}

                            {/* Delete (destructive) only when approved & no roles, never for self */}
                            {u.isApproved &&
                              !(isAdmin || isWorker) &&
                              !isMe &&
                              !isConfirming && (
                                <Button
                                  size={{ base: "xs", md: "sm" }}
                                  variant="outline"
                                  colorPalette="red"
                                  onClick={() =>
                                    setConfirm({ userId: u.id, kind: "delete" })
                                  }
                                  title="Remove this user completely"
                                >
                                  Delete
                                </Button>
                              )}
                          </>
                        )}
                      </>
                    )}
                  </Stack>
                )}
              </Stack>

              {/* Inline confirm bar (full width, below actions, mobile-friendly) */}
              {isConfirming && (
                <HStack
                  mt={3}
                  align="center"
                  p={3}
                  borderRadius="md"
                  borderWidth="1px"
                  borderColor="red.300"
                  bg="red.50"
                  justify="space-between"
                  flexWrap="wrap"
                  gap="2"
                >
                  <Text
                    fontSize="sm"
                    color="red.900"
                    flex="1 1 auto"
                    minW="220px"
                  >
                    {confirmKind === "decline"
                      ? "Decline this user? This removes their account and Clerk entry. This action cannot be undone."
                      : "Delete this user? This removes their account and Clerk entry. This action cannot be undone."}
                  </Text>
                  <HStack gap="2">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      colorPalette="red"
                      onClick={() => deleteUser(u.id)}
                    >
                      {confirmKind === "decline"
                        ? "Confirm decline"
                        : "Confirm delete"}
                    </Button>
                  </HStack>
                </HStack>
              )}

              {/* FULL-WIDTH ROW: holdings chips (never squashed by actions) */}
              {(holdingsByUser[u.id]?.length ?? 0) > 0 && (
                <Stack direction="row" gap="2" flexWrap="wrap" mt={2} w="full">
                  {holdingsByUser[u.id].map((h) => (
                    <Badge
                      key={h.equipmentId}
                      variant="subtle"
                      colorPalette={
                        h.state === "CHECKED_OUT" ? "red" : "orange"
                      }
                    >
                      {[h.brand, h.model, h.shortDesc]
                        .filter(Boolean)
                        .join(" - ")}{" "}
                      · {h.state.toLowerCase().replace("_", " ")}
                    </Badge>
                  ))}
                </Stack>
              )}
            </Box>
          );
        })}
    </Box>
  );
}
