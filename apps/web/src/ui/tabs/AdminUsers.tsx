// apps/web/src/components/AdminUsers.tsx
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  Box,
  Button,
  Heading,
  HStack,
  Stack,
  Text,
  Badge,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete } from "../../lib/api";
import { prettyStatus, equipmentStatusColor } from "../../lib/lib";
import { Role } from "../../lib/types";
import { getErrorMessage } from "../../lib/errors";
import { openAdminEquipmentSearchOnce } from "@/src/lib/bus";
import LoadingCenter from "../helpers/LoadingCenter";
import SearchWithClear from "../components/SearchWithClear";
import InlineMessage, { InlineMessageType } from "../helpers/InlineMessage";

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
  roles: Role[];
  email?: string | null;
  displayName?: string | null;
};

type Holding = {
  userId: string;
  equipmentId: string;
  shortDesc: string;
  brand: string | null;
  model: string | null;
  qrSlug: string | null;
  state: "RESERVED" | "CHECKED_OUT";
  reservedAt: string; // ISO
  checkedOutAt: string | null; // ISO
};

// Inline confirm state
type ConfirmKind = "delete" | "decline";
type ConfirmState = { userId: string; kind: ConfirmKind } | null;

// Status filter type for this page
type Status = "all" | "pending" | "approved";

export default function AdminUsers() {
  const [items, setItems] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);

  // who am I? (used to hide actions for self)
  const [me, setMe] = useState<Me | null>(null);
  const [meReady, setMeReady] = useState(false); // prevents action button flash

  // simple filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [role, setRole] = useState<"all" | "worker" | "admin">("all");

  const [inlineMsg, setInlineMsg] = useState<{
    msg: string;
    type: InlineMessageType;
  } | null>(null);

  // current holdings map (userId -> Holding[])
  const [holdingsByUser, setHoldingsByUser] = useState<
    Record<string, Holding[]>
  >({});

  // confirm bar state (for Delete or Decline)
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // Refs for focusing the status buttons when opened via event
  const allBtnRef = useRef<HTMLButtonElement | null>(null);
  const pendingBtnRef = useRef<HTMLButtonElement | null>(null);
  const approvedBtnRef = useRef<HTMLButtonElement | null>(null);

  // Listen for programmatic open: set status and focus corresponding button
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { status } = (e as CustomEvent<{ status?: Status }>).detail || {};
      if (status === "pending" || status === "approved" || status === "all") {
        setStatus(status);
        // focus the relevant button on the next frame
        requestAnimationFrame(() => {
          const target =
            status === "pending"
              ? pendingBtnRef.current
              : status === "approved"
                ? approvedBtnRef.current
                : allBtnRef.current;
          target?.focus();
        });
        // If you want to immediately reload here instead of waiting for the normal effect, you could call: void load();
      }
    };
    window.addEventListener("seedlings3:open-users", onOpen as EventListener);
    return () =>
      window.removeEventListener(
        "seedlings3:open-users",
        onOpen as EventListener
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
      setInlineMsg(null);
      setConfirm(null);
    } catch (err) {
      setInlineMsg({
        msg: "Failed to load users: " + getErrorMessage(err),
        type: InlineMessageType.ERROR,
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
      try {
        window.dispatchEvent(new Event("seedlings3:users-changed"));
      } catch {}
      await load();
      setInlineMsg({
        msg: "User approved",
        type: InlineMessageType.SUCCESS,
      });
    } catch (err) {
      setInlineMsg({
        msg: "Approve failed: " + getErrorMessage(err),
        type: InlineMessageType.ERROR,
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
      await load();
      setInlineMsg({
        msg: `Added ${role}`,
        type: InlineMessageType.SUCCESS,
      });
    } catch (err) {
      setInlineMsg({
        msg: "Add role failed: " + getErrorMessage(err),
        type: InlineMessageType.ERROR,
      });
    }
  }

  async function removeRole(userId: string, role: Role) {
    try {
      await apiDelete(`/api/admin/users/${userId}/roles/${role}`);
      await load();
      setInlineMsg({
        msg: `Removed ${role}`,
        type: InlineMessageType.SUCCESS,
      });
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

      setInlineMsg({
        msg: "Remove role failed: " + msg,
        type: InlineMessageType.ERROR,
      });
    }
  }

  // Hard delete (DB + Clerk) — used for both Delete and Decline confirmations
  async function deleteUser(userId: string) {
    try {
      await apiDelete(`/api/admin/users/${userId}`);
      try {
        window.dispatchEvent(new Event("seedlings3:users-changed"));
      } catch {}
      await load();
      setInlineMsg({
        msg: `User removed`,
        type: InlineMessageType.SUCCESS,
      });
      await load();
    } catch (err) {
      setInlineMsg({
        msg: "Remove failed: " + getErrorMessage(err),
        type: InlineMessageType.ERROR,
      });
    }
  }

  return (
    <Box w="full">
      <Heading size="md" mb={4}>
        Users & Access
      </Heading>

      {inlineMsg && <InlineMessage type={inlineMsg.type} msg={inlineMsg.msg} />}

      {/* Filters */}
      <Stack gap="3" mb={4}>
        <HStack gap="3" wrap="wrap">
          <HStack gap="2">
            <Text fontSize="sm" color="gray.600">
              Status:
            </Text>
            <HStack gap="1">
              <Button
                ref={allBtnRef}
                size="sm"
                variant={status === "all" ? "solid" : "outline"}
                onClick={() => setStatus("all")}
              >
                All
              </Button>
              <Button
                ref={pendingBtnRef}
                size="sm"
                variant={status === "pending" ? "solid" : "outline"}
                onClick={() => setStatus("pending")}
              >
                Pending
              </Button>
              <Button
                ref={approvedBtnRef}
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

          <SearchWithClear
            value={q}
            onChange={setQ}
            inputId="user-search"
            placeholder="Search name or email…"
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
          const isSuper = s.has("SUPER");
          const hasAnyRole = isAdmin || isWorker;
          const isMe = !!me?.id && u.id === me.id;
          const holdings = holdingsByUser[u.id] ?? [];

          const showDelete = u.isApproved && !hasAnyRole && !isMe;
          const showDecline = !u.isApproved && !isMe;

          const isConfirming = confirm?.userId === u.id;
          const confirmKind = confirm?.kind;

          const confirmCopy =
            confirmKind === "decline"
              ? "Decline this user? This removes their account and Clerk entry. This action cannot be undone."
              : "Delete this user? This removes their account and Clerk entry. This action cannot be undone.";

          const confirmCTA =
            confirmKind === "decline" ? "Confirm decline" : "Confirm delete";

          const displayName = u.displayName || u.email;

          return (
            <Box
              key={u.id}
              p={3}
              borderWidth="1px"
              borderRadius="lg"
              mb={3}
              w="full"
            >
              <Stack
                direction={{ base: "column", md: "row" }}
                align={{ base: "stretch", md: "start" }}
                justify="space-between"
                gap="3"
                w="full"
              >
                <Box flex="1 1 0" minW={0}>
                  <HStack
                    justify="space-between"
                    w="100%"
                    align="center"
                    wrap="wrap"
                    gap="6px"
                  >
                    <HStack gap="8px" minW="0">
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        overflow="hidden"
                        textOverflow="ellipsis"
                      >
                        {displayName || "(no name)"}
                      </Text>
                      {displayName !== u.email && <Badge>{u.email}</Badge>}
                    </HStack>
                  </HStack>

                  <HStack gap="2" mt={2} flexWrap="wrap">
                    <Badge colorPalette="green">
                      {u.isApproved ? "Approved" : "Pending"}
                    </Badge>
                    {isWorker && <Badge>Worker</Badge>}
                    {isAdmin && <Badge colorPalette="purple">Admin</Badge>}
                    {isSuper && <Badge colorPalette="yellow">Super</Badge>}
                  </HStack>
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
                            {isAdmin && !isSuper ? (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => removeRole(u.id, "ADMIN")}
                                variant="subtle"
                              >
                                Remove Admin
                              </Button>
                            ) : !isSuper ? (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => addRole(u.id, "ADMIN")}
                                variant="subtle"
                              >
                                Make Admin
                              </Button>
                            ) : null}
                            {isWorker && !isSuper ? (
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
                            ) : !isSuper ? (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => addRole(u.id, "WORKER")}
                                variant="outline"
                              >
                                Add Worker
                              </Button>
                            ) : null}
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
                                  disabled={
                                    me?.roles?.includes("SUPER") ? false : true
                                  }
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
                    {confirmCopy}
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
                      {confirmCTA}
                    </Button>
                  </HStack>
                </HStack>
              )}

              {(holdingsByUser[u.id]?.length ?? 0) > 0 && (
                <Stack direction="row" gap="2" flexWrap="wrap" mt={2} w="full">
                  {holdingsByUser[u.id].map((h) => (
                    <Badge
                      key={h.equipmentId}
                      onClick={() =>
                        openAdminEquipmentSearchOnce(h.qrSlug || "")
                      }
                      variant="subtle"
                      colorPalette={equipmentStatusColor(h.state)}
                    >{`${h.shortDesc} (${h.qrSlug}) - ${prettyStatus(h.state)}`}</Badge>
                  ))}
                </Stack>
              )}
            </Box>
          );
        })}
    </Box>
  );
}
