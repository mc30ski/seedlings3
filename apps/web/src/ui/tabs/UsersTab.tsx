// apps/web/src/components/AdminUsers.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Box,
  Button,
  HStack,
  Select,
  Stack,
  Text,
  Badge,
  createListCollection,
} from "@chakra-ui/react";
import { Filter, RefreshCw, Shield, X } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { prettyStatus, equipmentStatusColor } from "@/src/lib/lib";
import { Role } from "@/src/lib/types";
import { openEventSearch } from "@/src/lib/bus";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
//TODO:
export type TabRolePropType = { role: "worker" | "admin" };

type ApiUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  isApproved: boolean;
  roles: { role: Role }[];
  workerType?: string | null;
  insuranceCertR2Key?: string | null;
  insuranceExpiresAt?: string | null;
  contractorAgreedAt?: string | null;
  w9Collected?: boolean;
  w9CollectedAt?: string | null;
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

const statusFilterItems = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
];
const statusFilterCollection = createListCollection({ items: statusFilterItems });

const roleFilterItems = [
  { label: "All Roles", value: "all" },
  { label: "Worker", value: "worker" },
  { label: "Admin", value: "admin" },
];
const roleFilterCollection = createListCollection({ items: roleFilterItems });

export default function UsersTab({ role = "worker" }: TabRolePropType) {
  if (role !== "admin") return <UnavailableNotice />;

  const [items, setItems] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);

  // who am I? (used to hide actions for self)
  const [me, setMe] = useState<Me | null>(null);
  const [meReady, setMeReady] = useState(false); // prevents action button flash

  // simple filters
  const [q, setQ] = useState("");
  const [status, setStatus] = usePersistedState<Status>("users_status", "all");
  const [accessRole, setAccessRole] = usePersistedState<"all" | "worker" | "admin">(
    "users_role", "all"
  );

  // current holdings map (userId -> Holding[])
  const [holdingsByUser, setHoldingsByUser] = useState<
    Record<string, Holding[]>
  >({});

  // confirm bar state (for Delete or Decline)
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  // Listen for programmatic open: set status filter
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { status } = (e as CustomEvent<{ status?: Status }>).detail || {};
      if (status === "pending" || status === "approved" || status === "all") {
        setStatus(status);
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
      if (accessRole === "worker") params.set("role", "WORKER");
      if (accessRole === "admin") params.set("role", "ADMIN");

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
      setConfirm(null);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load users", err),
      });
    } finally {
      setLoading(false);
    }
  }, [status, accessRole]);

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
      publishInlineMessage({
        type: "SUCCESS",
        text: "User approved",
      });
      load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approve failed", err),
      });
    }
  }

  async function addRole(userId: string, accessRole: Role) {
    try {
      await apiPost(`/api/admin/users/${userId}/roles`, { role: accessRole });
      if (accessRole === "ADMIN") {
        try {
          await apiPost(`/api/admin/users/${userId}/roles`, {
            role: "WORKER",
          });
        } catch {}
      }
      publishInlineMessage({
        type: "SUCCESS",
        text: `Added ${accessRole}`,
      });
      load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Add role failed", err),
      });
    }
  }

  async function removeRole(userId: string, accessRole: Role) {
    try {
      await apiDelete(`/api/admin/users/${userId}/roles/${accessRole}`);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Removed ${accessRole}`,
      });
      load();
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
          : getErrorMessage("Remove role failed", err);

      publishInlineMessage({
        type: "ERROR",
        text: msg,
      });
    }
  }

  async function setWorkerType(userId: string, workerType: string) {
    try {
      await apiPatch(`/api/admin/users/${userId}/worker-type`, { workerType });
      publishInlineMessage({ type: "SUCCESS", text: `Set as ${workerType.toLowerCase()}` });
      load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Set worker type failed", err) });
    }
  }

  async function toggleW9(userId: string, current: boolean) {
    try {
      await apiPatch(`/api/admin/users/${userId}/w9`, { collected: !current });
      publishInlineMessage({ type: "SUCCESS", text: !current ? "W-9 marked collected" : "W-9 unmarked" });
      load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("W-9 update failed", err) });
    }
  }

  // Hard delete (DB + Clerk) — used for both Delete and Decline confirmations
  async function deleteUser(userId: string) {
    try {
      await apiDelete(`/api/admin/users/${userId}`);
      try {
        window.dispatchEvent(new Event("seedlings3:users-changed"));
      } catch {}
      publishInlineMessage({
        type: "SUCCESS",
        text: `User removed`,
      });
      load();
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Remove failed", err),
      });
    }
  }

  return (
    <Box w="full">
      {/* Filters */}
      <HStack mb={2} gap={2}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="user-search"
          placeholder="Search name or email…"
        />
        <Select.Root
          collection={statusFilterCollection}
          value={[status]}
          onValueChange={(e) => setStatus(e.value[0] as Status)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-blue-100)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {statusFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={roleFilterCollection}
          value={[accessRole]}
          onValueChange={(e) => setAccessRole(e.value[0] as "all" | "worker" | "admin")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-purple-100)", borderRadius: "6px" }}>
              <Shield size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {roleFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          disabled={status === "all" && accessRole === "all"}
          onClick={() => { setStatus("all"); setAccessRole("all"); }}
        >
          <X size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw size={14} />
        </Button>
      </HStack>
      {(status !== "all" || accessRole !== "all") && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {status !== "all" && (
            <Badge size="sm" colorPalette="blue" variant="solid">
              {statusFilterItems.find((i) => i.value === status)?.label}
            </Badge>
          )}
          {accessRole !== "all" && (
            <Badge size="sm" colorPalette="purple" variant="solid">
              {roleFilterItems.find((i) => i.value === accessRole)?.label}
            </Badge>
          )}
        </HStack>
      )}
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
          const isMe = !!me?.id && u.id === me.id;
          const showDecline = !u.isApproved && !isMe;

          const isConfirming = confirm?.userId === u.id;
          const confirmKind = confirm?.kind;

          const confirmCopy =
            confirmKind === "decline"
              ? "Decline this user? This removes their account and Clerk entry. This action cannot be undone."
              : "Delete this user? This removes their account and Clerk entry. This action cannot be undone.";

          const confirmCTA =
            confirmKind === "decline" ? "Confirm decline" : "Confirm delete";

          const isContractor = u.workerType === "CONTRACTOR";
          const isEmployee = u.workerType === "EMPLOYEE";
          const isTrainee = u.workerType === "TRAINEE";
          const insuranceExpired = isContractor && u.insuranceExpiresAt && new Date(u.insuranceExpiresAt) < new Date();
          const noInsurance = isContractor && !u.insuranceCertR2Key;
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
                    {isEmployee && <Badge colorPalette="blue">Employee</Badge>}
                    {isContractor && <Badge colorPalette="orange">Contractor</Badge>}
                    {isTrainee && <Badge colorPalette="cyan">Trainee</Badge>}
                    {!u.workerType && isWorker && <Badge colorPalette="gray" variant="outline">Unclassified</Badge>}
                    {isContractor && !noInsurance && !insuranceExpired && (
                      <Badge colorPalette="green" variant="subtle">Insured · {new Date(u.insuranceExpiresAt!).toLocaleDateString()}</Badge>
                    )}
                    {insuranceExpired && (
                      <Badge colorPalette="red" variant="solid">Insurance Expired</Badge>
                    )}
                    {noInsurance && (
                      <Badge colorPalette="red" variant="solid">No Insurance</Badge>
                    )}
                    {isContractor && u.contractorAgreedAt && (
                      <Badge colorPalette="teal" variant="subtle">Agreement Signed</Badge>
                    )}
                    {isContractor && u.w9Collected && (
                      <Badge colorPalette="teal" variant="subtle">W-9</Badge>
                    )}
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
                    {/* Worker type & W-9 — available for all users including self */}
                    {isWorker && u.workerType !== "TRAINEE" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => setWorkerType(u.id, "TRAINEE")}
                        variant="outline"
                        colorPalette="cyan"
                      >
                        Set Trainee
                      </Button>
                    )}
                    {isWorker && u.workerType !== "CONTRACTOR" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => setWorkerType(u.id, "CONTRACTOR")}
                        variant="outline"
                        colorPalette="orange"
                      >
                        Set Contractor
                      </Button>
                    )}
                    {isWorker && u.workerType !== "EMPLOYEE" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => setWorkerType(u.id, "EMPLOYEE")}
                        variant="outline"
                        colorPalette="blue"
                      >
                        Set Employee
                      </Button>
                    )}
                    {isContractor && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => toggleW9(u.id, !!u.w9Collected)}
                        variant={u.w9Collected ? "subtle" : "outline"}
                        colorPalette={u.w9Collected ? "teal" : "gray"}
                      >
                        {u.w9Collected ? "W-9 ✓" : "Collect W-9"}
                      </Button>
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
                        openEventSearch(
                          "activityTavToEquipmentTabQRCodeSearch",
                          h.qrSlug || "",
                          true
                        )
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
