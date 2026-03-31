// apps/web/src/components/AdminUsers.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Select,
  Stack,
  Text,
  Badge,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Filter, Info, RefreshCw, Shield, Tag, X } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { prettyStatus, equipmentStatusColor, fmtDate } from "@/src/lib/lib";
import { Role } from "@/src/lib/types";
import { openEventSearch } from "@/src/lib/bus";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
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
  { label: "Client", value: "client" },
];
const roleFilterCollection = createListCollection({ items: roleFilterItems });

const workerTypeFilterItems = [
  { label: "All Types", value: "all" },
  { label: "Unclassified", value: "unclassified" },
  { label: "Trainee", value: "TRAINEE" },
  { label: "Employee", value: "EMPLOYEE" },
  { label: "Contractor", value: "CONTRACTOR" },
];
const workerTypeFilterCollection = createListCollection({ items: workerTypeFilterItems });

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
  const [accessRole, setAccessRole] = usePersistedState<"all" | "worker" | "admin" | "client">(
    "users_role", "all"
  );
  const [workerTypeFilter, setWorkerTypeFilter] = usePersistedState("users_workerType", "all");
  const [showInfoOverlay, setShowInfoOverlay] = useState(() => {
    try {
      return !localStorage.getItem("seedlings_users_infoDismissed");
    } catch { return false; }
  });

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
      // "client" filter is applied client-side after fetch

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
    let rows = items;
    // Client filter: approved, no roles
    if (accessRole === "client") {
      rows = rows.filter((u) => u.isApproved && !u.roles.some((r) => r.role === "WORKER" || r.role === "ADMIN"));
    }
    if (workerTypeFilter !== "all") {
      if (workerTypeFilter === "unclassified") {
        rows = rows.filter((u) => !u.workerType && u.roles.some((r) => r.role === "WORKER"));
      } else {
        rows = rows.filter((u) => u.workerType === workerTypeFilter);
      }
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((u) => {
        const name = (u.displayName ?? "").toLowerCase();
        const email = (u.email ?? "").toLowerCase();
        return name.includes(qlc) || email.includes(qlc);
      });
    }
    return rows;
  }, [items, q, workerTypeFilter, accessRole]);

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

  const [workerTypeConfirm, setWorkerTypeConfirm] = useState<{ userId: string; workerType: string | null } | null>(null);

  function promptWorkerType(userId: string, workerType: string | null) {
    setWorkerTypeConfirm({ userId, workerType });
  }

  async function confirmWorkerType() {
    if (!workerTypeConfirm) return;
    const { userId, workerType } = workerTypeConfirm;
    setWorkerTypeConfirm(null);
    try {
      await apiPatch(`/api/admin/users/${userId}/worker-type`, { workerType });
      const label = workerType ? workerType.toLowerCase() : "unclassified";
      publishInlineMessage({ type: "SUCCESS", text: `Set as ${label}` });
      try { window.dispatchEvent(new Event("seedlings3:users-changed")); } catch {}
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
        <Select.Root
          collection={workerTypeFilterCollection}
          value={[workerTypeFilter]}
          onValueChange={(e) => setWorkerTypeFilter(e.value[0] ?? "all")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-orange-100)", borderRadius: "6px" }}>
              <Tag size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {workerTypeFilterItems.map((it) => (
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
          disabled={status === "all" && accessRole === "all" && workerTypeFilter === "all"}
          onClick={() => { setStatus("all"); setAccessRole("all"); setWorkerTypeFilter("all"); }}
        >
          <X size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => setShowInfoOverlay(true)}
          title="Role & type information"
        >
          <Info size={14} />
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
      {(status !== "all" || accessRole !== "all" || workerTypeFilter !== "all") && (
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
          {workerTypeFilter !== "all" && (
            <Badge size="sm" colorPalette="orange" variant="solid">
              {workerTypeFilterItems.find((i) => i.value === workerTypeFilter)?.label}
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
              <VStack align="stretch" gap="3" w="full">
                <Box>
                  <HStack gap="8px" wrap="wrap" align="center">
                    <Text fontSize="sm" fontWeight="semibold">
                      {displayName || "(no name)"}
                    </Text>
                    {displayName !== u.email && <Badge>{u.email}</Badge>}
                  </HStack>

                  <HStack gap="2" mt={2} flexWrap="wrap">
                    <Badge colorPalette="green">
                      {u.isApproved ? "Approved" : "Pending"}
                    </Badge>
                    {isWorker && <Badge>Worker</Badge>}
                    {isAdmin && <Badge colorPalette="purple">Admin</Badge>}
                    {isSuper && <Badge colorPalette="yellow">Super</Badge>}
                    {u.isApproved && !isWorker && !isAdmin && <Badge colorPalette="green">Client</Badge>}
                    {isEmployee && <Badge colorPalette="blue">Employee</Badge>}
                    {isContractor && <Badge colorPalette="orange">Contractor</Badge>}
                    {isTrainee && <Badge colorPalette="cyan">Trainee</Badge>}
                    {!u.workerType && isWorker && <Badge colorPalette="gray" variant="outline">Unclassified</Badge>}
                    {isContractor && !noInsurance && !insuranceExpired && (
                      <Badge colorPalette="green" variant="subtle">Insured · {fmtDate(u.insuranceExpiresAt)}</Badge>
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
                        onClick={() => promptWorkerType(u.id, "TRAINEE")}
                        variant="outline"
                        colorPalette="cyan"
                      >
                        Set Trainee
                      </Button>
                    )}
                    {isWorker && u.workerType !== "CONTRACTOR" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, "CONTRACTOR")}
                        variant="outline"
                        colorPalette="orange"
                      >
                        Set Contractor
                      </Button>
                    )}
                    {isWorker && u.workerType !== "EMPLOYEE" && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, "EMPLOYEE")}
                        variant="outline"
                        colorPalette="blue"
                      >
                        Set Employee
                      </Button>
                    )}
                    {isWorker && u.workerType != null && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => promptWorkerType(u.id, null)}
                        variant="outline"
                        colorPalette="gray"
                      >
                        Unclassify
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
              </VStack>

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
      <ConfirmDialog
        open={!!workerTypeConfirm}
        title="Change Worker Type"
        message={`Are you sure you want to set this worker as ${workerTypeConfirm?.workerType?.toLowerCase() ?? "unclassified"}?`}
        confirmLabel="Confirm"
        onConfirm={confirmWorkerType}
        onCancel={() => setWorkerTypeConfirm(null)}
      />

      {/* Roles & Types Info Overlay */}
      <Dialog.Root open={showInfoOverlay} onOpenChange={(e) => { if (!e.open) setShowInfoOverlay(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg" maxH="80vh" overflowY="auto">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Roles & Worker Types</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={4}>
                  <Box>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Access Roles</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>Controls what parts of the app a user can access.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md">
                    <Badge colorPalette="gray" mb={1}>Worker</Badge>
                    <Text fontSize="sm">Can see Worker tabs (Jobs, Equipment, Clients, Properties, Payments). Can claim jobs, start/complete work, accept payments, reserve equipment, and upload photos.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md">
                    <Badge colorPalette="purple" mb={1}>Admin</Badge>
                    <Text fontSize="sm">Can see Admin tabs (Jobs, Services, Equipment, Clients, Properties, Payments, Users, Audit, Settings). Can manage all data, create jobs, assign workers, approve users, and configure settings. Also has Worker access.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md">
                    <Badge colorPalette="yellow" mb={1}>Super</Badge>
                    <Text fontSize="sm">An Admin bootstrapped via environment config. Cannot be deleted or have roles removed. Can modify platform settings. Has all Admin + Worker capabilities.</Text>
                  </Box>

                  <Box mt={2}>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Worker Types</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>Classifies how a worker is employed. Determines financial treatment and access restrictions.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="gray.300">
                    <Badge colorPalette="gray" variant="outline" mb={1}>Unclassified</Badge>
                    <Text fontSize="sm">Worker type not yet assigned. Can claim standard jobs (under the high-value threshold). Cannot claim high-value jobs. No platform fee. No insurance requirement. Should be classified by an admin.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="cyan.300">
                    <Badge colorPalette="cyan" mb={1}>Trainee</Badge>
                    <Text fontSize="sm">A restricted Employee (W-2) intended for new hires who are shadowing or in training. Treated the same as an Employee financially — no platform fee, no insurance requirement, no contractor agreement. However, they have limited capabilities: cannot claim jobs, take actions (start/complete), accept payments, or reserve equipment. Limited visibility — only sees jobs, clients, and properties they participate in. Cannot see tentative or unassigned jobs. Must rely on a team manager for all actions on their behalf.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="blue.300">
                    <Badge colorPalette="blue" mb={1}>Employee (W-2)</Badge>
                    <Text fontSize="sm">Full access. Can claim any job including high-value. Can reserve any equipment. No insurance requirement. No platform fee on payments. No contractor agreement required.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="orange.300">
                    <Badge colorPalette="orange" mb={1}>Contractor (1099)</Badge>
                    <Text fontSize="sm">Must acknowledge a contractor agreement every time they claim a job. Can claim standard jobs without insurance. High-value jobs and insurance-flagged equipment require a valid insurance certificate. Platform fee (configured in Settings) is deducted from their payment splits after expenses. Admin tracks W-9 collection and insurance expiration.</Text>
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      try { localStorage.removeItem("seedlings_users_infoDismissed"); } catch {}
                      setShowInfoOverlay(false);
                    }}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      try { localStorage.setItem("seedlings_users_infoDismissed", "1"); } catch {}
                      setShowInfoOverlay(false);
                    }}
                  >
                    Don't show again
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
