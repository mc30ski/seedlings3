// apps/web/src/components/AdminUsers.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Stack,
  Switch,
  Text,
  Badge,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { ChevronDown, ChevronRight, Filter, Info, RefreshCw, Shield, Tag, X } from "lucide-react";
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
// `readOnly` lets non-super admins see the directory without any
// mutation surface — no approve, no role/worker-type changes, no
// privilege toggles, no delete, and pending users are hidden entirely
// (since admins can't act on them anyway). User-management is now a
// SUPER-only activity.
export type TabRolePropType = { role: "worker" | "admin"; readOnly?: boolean };

type ApiUser = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  isApproved: boolean;
  roles: { role: Role }[];
  workerType?: string | null;
  isOwner?: boolean;
  insuranceCertR2Key?: string | null;
  insuranceExpiresAt?: string | null;
  contractorAgreedAt?: string | null;
  w9Collected?: boolean;
  w9CollectedAt?: string | null;
  // Guaranteed-payout onboarding period (contractors only). Active when
  // guaranteedPayoutUntil > now. See onboarding addendum.
  guaranteedPayoutUntil?: string | null;
  guaranteedPayoutStartedAt?: string | null;
  // Per-user privilege overrides. Null = follow workerType default.
  canPullInventory?: boolean | null;
  canChargeBusinessExpenses?: boolean | null;
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
type ConfirmKind = "delete" | "decline" | "approve-worker";
type ConfirmState = { userId: string; kind: ConfirmKind } | null;

// Status filter type for this page
type Status = "all" | "pending" | "approved";

const statusFilterItems = [
  { label: "All Statuses", value: "all" },
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

export default function UsersTab({ role = "worker", readOnly = false }: TabRolePropType) {
  if (role !== "admin") return <UnavailableNotice />;

  const [items, setItems] = useState<ApiUser[]>([]);
  const [loading, setLoading] = useState(false);

  // who am I? (used to hide actions for self)
  const [me, setMe] = useState<Me | null>(null);
  const [meReady, setMeReady] = useState(false); // prevents action button flash

  // Collapsed-by-default Permissions section per user. Most admin tasks
  // don't involve toggling these — keep the card compact unless drilled in.
  const [permsOpen, setPermsOpen] = useState<Set<string>>(new Set());

  // simple filters
  const [q, setQ] = useState("");
  const [status, setStatus] = usePersistedState<Status>("users_status", "all");
  const [accessRole, setAccessRole] = usePersistedState<"all" | "worker" | "admin" | "client">(
    "users_role", "all"
  );
  const [workerTypeFilter, setWorkerTypeFilter] = usePersistedState("users_workerType", "all");
  // Section toggles — the directory is split three ways:
  //   • Pending  — unapproved sign-ups awaiting Approve/Decline. Defaults to
  //                open because pending rows represent unfinished work.
  //   • Team     — approved workers/admins/super. Defaults to open since
  //                most directory tasks target it.
  //   • Clients  — approved users with no operational role. Defaults to
  //                collapsed so admins don't accidentally interact with
  //                client rows during routine team management.
  const [pendingSectionOpen, setPendingSectionOpen] = usePersistedState("users_pendingSectionOpen", true);
  const [teamSectionOpen, setTeamSectionOpen] = usePersistedState("users_teamSectionOpen", true);
  const [clientSectionOpen, setClientSectionOpen] = usePersistedState("users_clientSectionOpen", false);

  // Guaranteed-payout filter. "all" = no filter; "active" = only
  // contractors currently in an open period; "expiring" = active AND
  // ≤ 7 days from expiration (the title-bar alert chip routes here).
  // Not persisted — it's a transient navigational filter; reopening the
  // tab fresh shouldn't carry over a previous filter session.
  const [guaranteedPayoutFilter, setGuaranteedPayoutFilter] =
    useState<"all" | "active" | "expiring">("all");

  // Check for pending approvals / guaranteed-payout navigation from header
  // badge — on mount and via event. Supports two payload shapes:
  //   { status } → set the status filter (pending users path)
  //   { guaranteedPayoutFilter } → set the GP filter (alert chip path)
  useEffect(() => {
    try {
      const flag = sessionStorage.getItem("admin:usersOpenOnce");
      if (flag) {
        sessionStorage.removeItem("admin:usersOpenOnce");
        const parsed = JSON.parse(flag);
        if (parsed?.status) setStatus(parsed.status);
        if (parsed?.guaranteedPayoutFilter) {
          setGuaranteedPayoutFilter(parsed.guaranteedPayoutFilter);
        }
      }
    } catch {}
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail?.status) setStatus(detail.status);
      if (detail?.guaranteedPayoutFilter) {
        setGuaranteedPayoutFilter(detail.guaranteedPayoutFilter);
      }
    };
    window.addEventListener("admin:openUsers", onOpen as EventListener);
    return () => window.removeEventListener("admin:openUsers", onOpen as EventListener);
  }, []);
  // Info overlay is opt-in only — opens when the user taps the (i) button.
  // Used to auto-open on first visit (gated by a localStorage dismiss flag);
  // that behavior was removed to stop surprise modals from interrupting
  // returning users on fresh devices / browser sessions.
  const [showInfoOverlay, setShowInfoOverlay] = useState(false);

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

  // General filters applied to every section (Pending / Team / Clients).
  // Worker-specific filters (workerTypeFilter, guaranteedPayoutFilter) are
  // applied AFTER segmenting, only to the Team subset — they don't make
  // sense for clients or pending users.
  const filtered = useMemo(() => {
    let rows = items;
    // Read-only mode: pending users hidden entirely. Admins (non-super)
    // can't act on them and shouldn't be tempted to try; the "Pending
    // Users" alert badge has been moved to super-only, so this is the
    // only surface where they might have seen them.
    if (readOnly) {
      rows = rows.filter((u) => u.isApproved);
    }
    // Client filter: approved, no roles
    if (accessRole === "client") {
      rows = rows.filter((u) => u.isApproved && !u.roles.some((r) => r.role === "WORKER" || r.role === "ADMIN"));
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
  }, [items, q, accessRole, readOnly]);

  // Section predicates. Each user lands in exactly one of Pending / Team /
  // Clients (the three are mutually exclusive and exhaustive).
  //   Pending = not yet approved — pre-decision row.
  //   Team    = approved AND has Worker or Admin role.
  //   Client  = approved AND no operational role.
  const isPendingUser = (u: ApiUser): boolean => !u.isApproved;
  const isTeamUser = (u: ApiUser): boolean =>
    u.isApproved && u.roles.some((r) => r.role === "WORKER" || r.role === "ADMIN");
  const isClientUser = (u: ApiUser): boolean =>
    u.isApproved && !u.roles.some((r) => r.role === "WORKER" || r.role === "ADMIN");

  const pendingUsers = useMemo(() => filtered.filter(isPendingUser), [filtered]);
  // Team gets the worker-specific filters layered on top. Clients and pending
  // users are never narrowed by workerType or guaranteed-payout — those are
  // worker-only concepts.
  const teamUsers = useMemo(() => {
    let rows = filtered.filter(isTeamUser);
    if (workerTypeFilter !== "all") {
      if (workerTypeFilter === "unclassified") {
        rows = rows.filter((u) => !u.workerType && u.roles.some((r) => r.role === "WORKER"));
      } else {
        rows = rows.filter((u) => u.workerType === workerTypeFilter);
      }
    }
    if (guaranteedPayoutFilter !== "all") {
      const now = Date.now();
      const sevenDaysOut = now + 7 * 86400000;
      rows = rows.filter((u) => {
        if (!u.guaranteedPayoutUntil) return false;
        const untilMs = new Date(u.guaranteedPayoutUntil).getTime();
        if (guaranteedPayoutFilter === "active") return untilMs > now;
        return untilMs > now && untilMs <= sevenDaysOut;
      });
    }
    return rows;
  }, [filtered, workerTypeFilter, guaranteedPayoutFilter]);
  const clientUsers = useMemo(() => filtered.filter(isClientUser), [filtered]);

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
  // Remove-worker confirm — destructive enough to need an explicit modal
  // (vs. the inline bar used for Delete/Decline). Loses worker capabilities
  // but doesn't delete the user.
  const [removeWorkerConfirm, setRemoveWorkerConfirm] = useState<{ userId: string; displayName: string } | null>(null);

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

  // Owner-flag toggle (super-only). Singleton enforced server-side. We mirror
  // it client-side so the button doesn't render on users who can't take it
  // anyway — clicking would just 409 with OWNER_ALREADY_SET.
  const hasOwner = useMemo(() => items.some((u) => u.isOwner), [items]);
  const [ownerConfirm, setOwnerConfirm] = useState<{ userId: string; isOwner: boolean; displayName: string } | null>(null);

  // Contractor "guaranteed payout period" management (super-only). Target
  // carries the contractor and the form state for the date picker; null =
  // dialog closed. Default: today + 60 days. Operator may pick 1-90 days
  // out from today; the dialog enforces the bound via the date input's
  // min/max and the save handler revalidates.
  const [guaranteedPayoutTarget, setGuaranteedPayoutTarget] = useState<
    | { user: ApiUser; mode: "start" | "manage"; dateInput: string }
    | null
  >(null);
  const [guaranteedPayoutBusy, setGuaranteedPayoutBusy] = useState(false);
  async function saveGuaranteedPayout(until: string | null) {
    if (!guaranteedPayoutTarget) return;
    // Re-validate the 1-90 day window before sending (defense in depth —
    // the input min/max bounds the picker, but a user could type past it
    // in some browsers).
    if (until) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + 90);
      const maxIso = maxDate.toISOString().slice(0, 10);
      if (until < todayIso) {
        publishInlineMessage({ type: "ERROR", text: "End date must be today or later." });
        return;
      }
      if (until > maxIso) {
        publishInlineMessage({ type: "ERROR", text: "End date can't be more than 90 days from today." });
        return;
      }
    }
    setGuaranteedPayoutBusy(true);
    try {
      await apiPatch(`/api/admin/users/${guaranteedPayoutTarget.user.id}/guaranteed-payout-period`, { until });
      publishInlineMessage({
        type: "SUCCESS",
        text: until
          ? `Guaranteed payout period set through ${until} for ${guaranteedPayoutTarget.user.displayName ?? guaranteedPayoutTarget.user.email}.`
          : `Guaranteed payout period ended early for ${guaranteedPayoutTarget.user.displayName ?? guaranteedPayoutTarget.user.email}.`,
      });
      setGuaranteedPayoutTarget(null);
      load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Guaranteed payout update failed", err) });
    } finally {
      setGuaranteedPayoutBusy(false);
    }
  }
  async function confirmOwner() {
    if (!ownerConfirm) return;
    const { userId, isOwner } = ownerConfirm;
    setOwnerConfirm(null);
    try {
      await apiPatch(`/api/admin/users/${userId}/owner`, { isOwner });
      publishInlineMessage({ type: "SUCCESS", text: isOwner ? "Flagged as LLC owner." : "Owner flag cleared." });
      try { window.dispatchEvent(new Event("seedlings3:users-changed")); } catch {}
      load();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Owner flag update failed", err) });
    }
  }

  // Privilege overrides — set to null (use default), true (grant), or false (deny).
  // Optimistic in-place update so the row doesn't unmount and the page doesn't
  // jump back to the top from a full re-fetch.
  async function setPrivilegeOverride(
    userId: string,
    key: "canPullInventory" | "canChargeBusinessExpenses",
    value: boolean | null,
  ) {
    const prev = items.find((u) => u.id === userId);
    const userLabel = prev?.displayName || prev?.email || "user";
    const permLabel = key === "canPullInventory" ? "Use company supplies" : "Charge business expenses";
    setItems((rows) => rows.map((u) => (u.id === userId ? { ...u, [key]: value } : u)));
    try {
      await apiPatch(`/api/admin/users/${userId}/privileges`, { [key]: value });
      const stateText = value === true ? "ON" : value === false ? "OFF" : "default";
      publishInlineMessage({
        type: "SUCCESS",
        text: `${permLabel} → ${stateText} for ${userLabel}`,
      });
    } catch (err: any) {
      // Roll back on failure
      if (prev) {
        setItems((rows) => rows.map((u) => (u.id === userId ? { ...u, [key]: prev[key] } : u)));
      }
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update failed", err) });
    }
  }

  // Defaults by workerType — mirror of the server's privileges.ts.
  // Used to show "(default: ✅/❌)" hints next to the override selector.
  const PRIV_DEFAULTS: Record<string, { canPullInventory: boolean; canChargeBusinessExpenses: boolean }> = {
    TRAINEE: { canPullInventory: false, canChargeBusinessExpenses: false },
    CONTRACTOR: { canPullInventory: true, canChargeBusinessExpenses: false },
    EMPLOYEE: { canPullInventory: true, canChargeBusinessExpenses: false },
  };
  function resolveEffective(u: any, key: "canPullInventory" | "canChargeBusinessExpenses"): boolean {
    const isAdmin = u.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (isAdmin) return true;
    const override = u[key];
    if (override === true || override === false) return override;
    const def = u.workerType ? PRIV_DEFAULTS[u.workerType] : { canPullInventory: false, canChargeBusinessExpenses: false };
    return def[key];
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
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)" }}>
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="user-search"
          placeholder="Search…"
        />
        {/* Status filter — hidden in read-only mode since pending users
         *  are excluded from the list entirely. Approved-only is the
         *  only meaningful view for read-only admins. */}
        {!readOnly && <Select.Root
          collection={statusFilterCollection}
          value={[status]}
          onValueChange={(e) => setStatus(e.value[0] as Status)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: status !== "all" ? "var(--chakra-colors-blue-200)" : "var(--chakra-colors-blue-100)", border: status !== "all" ? "1px solid var(--chakra-colors-blue-400)" : "1px solid var(--chakra-colors-blue-300)", borderRadius: "6px" }}>
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
        </Select.Root>}
        <Select.Root
          collection={roleFilterCollection}
          value={[accessRole]}
          onValueChange={(e) => setAccessRole(e.value[0] as "all" | "worker" | "admin")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: accessRole !== "all" ? "var(--chakra-colors-purple-200)" : "var(--chakra-colors-purple-100)", border: accessRole !== "all" ? "1px solid var(--chakra-colors-purple-400)" : "1px solid var(--chakra-colors-purple-300)", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: workerTypeFilter !== "all" ? "var(--chakra-colors-orange-200)" : "var(--chakra-colors-orange-100)", border: workerTypeFilter !== "all" ? "1px solid var(--chakra-colors-orange-400)" : "1px solid var(--chakra-colors-orange-300)", borderRadius: "6px" }}>
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
          onClick={() => setShowInfoOverlay(true)}
          title="Role & type information"
        >
          <Info size={14} />
        </Button>
      </HStack>
      {(status !== "all" || accessRole !== "all" || workerTypeFilter !== "all" || guaranteedPayoutFilter !== "all") && (
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
          {guaranteedPayoutFilter !== "all" && (
            <Badge size="sm" colorPalette={guaranteedPayoutFilter === "expiring" ? "yellow" : "purple"} variant="solid">
              {guaranteedPayoutFilter === "expiring" ? "Guaranteed payout expiring (≤7d)" : "Guaranteed payout active"}
            </Badge>
          )}
          {!(status === "all" && accessRole === "all" && workerTypeFilter === "all" && guaranteedPayoutFilter === "all") && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setStatus("all");
                setAccessRole("all");
                setWorkerTypeFilter("all");
                setGuaranteedPayoutFilter("all");
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      {/* List */}
      {loading && <LoadingCenter />}
      {!loading && filtered.length === 0 && (
        <Box textAlign="center" py={6}>
          <Text color="fg.muted">No users match the current filters.</Text>
          <Button
            size="sm"
            variant="outline"
            mt={2}
            onClick={() => {
              setStatus("all");
              setAccessRole("all");
              setWorkerTypeFilter("all");
              setGuaranteedPayoutFilter("all");
              setQ("");
            }}
          >
            Clear filters
          </Button>
        </Box>
      )}
      {!loading && filtered.length > 0 && (() => {
        const renderUserCard = (u: ApiUser) => {
          const s = rolesSet(u);
          const isAdmin = s.has("ADMIN");
          const isWorker = s.has("WORKER");
          const isSuper = s.has("SUPER");
          const isMe = !!me?.id && u.id === me.id;
          const isClient = u.isApproved && !isWorker && !isAdmin;
          const showDecline = !u.isApproved && !isMe;

          const isConfirming = confirm?.userId === u.id;
          const confirmKind = confirm?.kind;

          const confirmCopy =
            confirmKind === "approve-worker"
              ? "Approve this user as a worker? They will be able to claim jobs, manage equipment, and access the Worker tab."
              : confirmKind === "decline"
              ? "Decline this user? This removes their account and Clerk entry. This action cannot be undone."
              : "Delete this user? This removes their account and Clerk entry. This action cannot be undone.";

          const confirmCTA =
            confirmKind === "approve-worker" ? "Confirm approve" : confirmKind === "decline" ? "Confirm decline" : "Confirm delete";

          const isContractor = u.workerType === "CONTRACTOR";
          const isEmployee = u.workerType === "EMPLOYEE";
          const isTrainee = u.workerType === "TRAINEE";
          const insuranceExpired = isContractor && u.insuranceExpiresAt && new Date(u.insuranceExpiresAt) < new Date();
          const noInsurance = isContractor && !u.insuranceCertR2Key;
          const displayName = u.displayName || u.email;

          // Guaranteed-payout state derived per-row. Active when the
          // server's guaranteedPayoutUntil is in the future; the chip
          // surfaces remaining days so the operator can see at a glance
          // how close each contractor is to reverting to standard
          // contingent terms.
          const guaranteedPayoutUntilDate = u.guaranteedPayoutUntil ? new Date(u.guaranteedPayoutUntil) : null;
          const guaranteedPayoutActive = !!(guaranteedPayoutUntilDate && guaranteedPayoutUntilDate.getTime() > Date.now());
          const guaranteedPayoutDaysLeft = guaranteedPayoutActive && guaranteedPayoutUntilDate
            ? Math.max(0, Math.ceil((guaranteedPayoutUntilDate.getTime() - Date.now()) / 86400000))
            : 0;

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
                    {u.isOwner && <Badge colorPalette="purple" variant="solid">LLC Owner</Badge>}
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
                    {isContractor && u.w9Collected && (
                      <Badge colorPalette="teal" variant="subtle">W-9</Badge>
                    )}
                    {isContractor && guaranteedPayoutActive && (
                      <Badge
                        colorPalette={guaranteedPayoutDaysLeft <= 7 ? "yellow" : "purple"}
                        variant="solid"
                        title={`Guaranteed payout period — payroll work-anchored through ${fmtDate(u.guaranteedPayoutUntil)}. ${guaranteedPayoutDaysLeft <= 7 ? "Approaching expiration — confirm transition with the contractor." : ""}`}
                      >
                        Guaranteed payout · {guaranteedPayoutDaysLeft}d left
                      </Badge>
                    )}
                  </HStack>
                </Box>

                {/* Actions — entire mutation surface is super-only. In
                 *  read-only mode (Admin Directory → Users) the card
                 *  renders identity badges only, no buttons. */}
                {!readOnly && meReady && (
                  <Stack
                    direction="row"
                    gap="2"
                    flexWrap="wrap"
                    justify="flex-start"
                  >
                    {isMe ? null : (
                      <>
                        {!u.isApproved ? (
                          <>
                            <Button
                              size={{ base: "xs", md: "sm" }}
                              onClick={() => approve(u.id)}
                            >
                              Approve as Client
                            </Button>
                            <Button
                              size={{ base: "xs", md: "sm" }}
                              variant="ghost"
                              onClick={() =>
                                setConfirm({ userId: u.id, kind: "approve-worker" as any })
                              }
                            >
                              Approve as Worker
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
                            {/* "Make Worker" disabled per operator preference:
                                Clients should never be promoted to Workers
                                via this directory because doing so exposes
                                internal data (jobs, payments, equipment) to
                                someone the business considers external.
                                Preserved here behind a `false` guard so the
                                control can be restored by flipping the flag
                                if a future workflow legitimately needs it
                                (e.g. a client who's joining the team as a
                                contractor — done via a dedicated flow then).
                                Server route still accepts the role grant, so
                                no API change is required to restore. */}
                            {false && isClient && (
                              <Button
                                size={{ base: "xs", md: "sm" }}
                                onClick={() => addRole(u.id, "WORKER")}
                                variant="subtle"
                              >
                                Make Worker
                              </Button>
                            )}
                            {!isClient && (
                              <>
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
                                    onClick={() => setRemoveWorkerConfirm({ userId: u.id, displayName: u.displayName || u.email || "this user" })}
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
                              </>
                            )}
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
                    {/* Guaranteed payout period — Super-only mutation.
                        Opens the date picker dialog; handles both "Start"
                        (no current period) and "Manage" (active, can extend
                        or end early). Button shows current state inline. */}
                    {isContractor && me?.roles?.includes("SUPER") && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        variant={guaranteedPayoutActive ? "subtle" : "outline"}
                        colorPalette={guaranteedPayoutActive ? "purple" : "gray"}
                        onClick={() => {
                          // Default to today + 60 days for fresh starts, or
                          // the current end date when managing an active
                          // period. Operator can pick anywhere from 1-90
                          // days out via the date input's min/max.
                          const defaultDate = guaranteedPayoutActive && u.guaranteedPayoutUntil
                            ? u.guaranteedPayoutUntil.slice(0, 10)
                            : (() => {
                                const d = new Date();
                                d.setDate(d.getDate() + 60);
                                return d.toISOString().slice(0, 10);
                              })();
                          setGuaranteedPayoutTarget({
                            user: u,
                            mode: guaranteedPayoutActive ? "manage" : "start",
                            dateInput: defaultDate,
                          });
                        }}
                      >
                        {guaranteedPayoutActive ? "Guaranteed payout ✓" : "Start guaranteed payout"}
                      </Button>
                    )}
                    {/* LLC-owner toggle. SUPER-only — the route enforces it
                        too. Singleton: only one user can hold the flag, so
                        once any user is flagged, the "Set as Owner" button
                        is hidden on everyone else (server would 409 anyway).
                        The current owner keeps the "Owner ✓" button so they
                        can be unflagged. */}
                    {me?.roles?.includes("SUPER") && (u.isOwner || !hasOwner) && (
                      <Button
                        size={{ base: "xs", md: "sm" }}
                        onClick={() => setOwnerConfirm({ userId: u.id, isOwner: !u.isOwner, displayName: u.displayName ?? u.email ?? u.id })}
                        variant={u.isOwner ? "subtle" : "outline"}
                        colorPalette={u.isOwner ? "purple" : "gray"}
                      >
                        {u.isOwner ? "Owner ✓" : "Set as Owner"}
                      </Button>
                    )}
                  </Stack>
                )}

                {/* Permissions — collapsed by default. Header toggles open;
                    body shows the same per-permission switches as before.
                    Read-only mode renders the switches in their current
                    state but disabled, so admins can see what's granted
                    without being able to mutate it. */}
                {isWorker && (() => {
                  const open = permsOpen.has(u.id);
                  return (
                    <Box mt={3} pt={3} borderTopWidth="1px" borderColor="gray.200">
                      <HStack
                        gap={1}
                        cursor="pointer"
                        onClick={() => {
                          setPermsOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.id)) next.delete(u.id);
                            else next.add(u.id);
                            return next;
                          });
                        }}
                        _hover={{ color: "fg" }}
                        color="fg.muted"
                        userSelect="none"
                      >
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <Text fontSize="xs" fontWeight="medium">
                          Permissions
                        </Text>
                      </HStack>
                      {open && (
                        <VStack align="stretch" gap={2} mt={2}>
                          {[
                            {
                              key: "canPullInventory" as const,
                              label: "Use company supplies",
                              help: "Pull from already-purchased inventory on jobs they've claimed.",
                            },
                            {
                              key: "canChargeBusinessExpenses" as const,
                              label: "Charge business expenses",
                              help: "Record new expenses paid on the company account (gas, parts, etc.).",
                            },
                          ].map((perm) => {
                            const grantedByRole = isAdmin || isSuper;
                            const effective = grantedByRole
                              ? true
                              : resolveEffective(u, perm.key);
                            return (
                              <HStack
                                key={perm.key}
                                justify="space-between"
                                align="flex-start"
                                gap={3}
                              >
                                <Box flex="1" minW={0}>
                                  <Text fontSize="sm" fontWeight="medium">
                                    {perm.label}
                                  </Text>
                                  <Text fontSize="xs" color="fg.muted">
                                    {grantedByRole
                                      ? "Granted automatically by Admin/Super role."
                                      : perm.help}
                                  </Text>
                                </Box>
                                <Switch.Root
                                  checked={effective}
                                  // Disabled when role-granted (can't
                                  // override an Admin/Super grant) OR
                                  // when this whole tab is read-only
                                  // (admin's directory view — Super
                                  // does the actual editing on the
                                  // Super Users tab).
                                  disabled={grantedByRole || readOnly}
                                  onCheckedChange={(e) => {
                                    if (readOnly) return;
                                    void setPrivilegeOverride(u.id, perm.key, e.checked);
                                  }}
                                  colorPalette="green"
                                >
                                  <Switch.HiddenInput />
                                  <Switch.Control>
                                    <Switch.Thumb />
                                  </Switch.Control>
                                </Switch.Root>
                              </HStack>
                            );
                          })}
                        </VStack>
                      )}
                    </Box>
                  );
                })()}
              </VStack>

              {isConfirming && (
                <HStack
                  mt={3}
                  align="center"
                  p={3}
                  borderRadius="md"
                  borderWidth="1px"
                  borderColor={confirmKind === "approve-worker" ? "green.300" : "red.300"}
                  bg={confirmKind === "approve-worker" ? "green.50" : "red.50"}
                  justify="space-between"
                  flexWrap="wrap"
                  gap="2"
                >
                  <Text
                    fontSize="sm"
                    color={confirmKind === "approve-worker" ? "green.900" : "red.900"}
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
                      colorPalette={confirmKind === "approve-worker" ? "green" : "red"}
                      onClick={async () => {
                        if (confirmKind === "approve-worker") {
                          try {
                            await apiPost(`/api/admin/users/${u.id}/approve`);
                            await addRole(u.id, "WORKER");
                            window.dispatchEvent(new Event("seedlings3:users-changed"));
                            publishInlineMessage({ type: "SUCCESS", text: "User approved as worker." });
                            setConfirm(null);
                            load();
                          } catch (err: any) {
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Approve failed.", err) });
                          }
                        } else {
                          deleteUser(u.id);
                        }
                      }}
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
                      css={{ whiteSpace: "normal", wordBreak: "break-word", maxWidth: "100%" }}
                      fontSize="xs"
                    >{`${h.shortDesc} (${h.qrSlug}) - ${prettyStatus(h.state)}`}</Badge>
                  ))}
                </Stack>
              )}
            </Box>
          );
        };

        // Section header — collapsible, shows the group name + count.
        // Made visually prominent: larger type, taller, accent-colored band
        // on the left so the three sections clearly separate the directory
        // into distinct piles instead of looking like sub-rows.
        const SectionHeader = ({ label, count, open, onToggle, accent }: { label: string; count: number; open: boolean; onToggle: () => void; accent: string }) => (
          <HStack
            gap={2}
            mb={2}
            mt={4}
            px={3}
            py={2}
            cursor="pointer"
            onClick={onToggle}
            borderRadius="md"
            bg="gray.100"
            borderWidth="1px"
            borderColor="gray.300"
            borderLeftWidth="4px"
            borderLeftColor={accent}
            _hover={{ bg: "gray.200" }}
            userSelect="none"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Text fontSize="sm" fontWeight="semibold" textTransform="uppercase" letterSpacing="wide">
              {label} ({count})
            </Text>
          </HStack>
        );

        return (
          <>
            <SectionHeader
              label="Pending"
              count={pendingUsers.length}
              open={pendingSectionOpen}
              onToggle={() => setPendingSectionOpen((v) => !v)}
              accent="orange.400"
            />
            {pendingSectionOpen && (
              pendingUsers.length === 0
                ? <Text fontSize="sm" color="fg.muted" pl={2} mb={3}>No pending sign-ups.</Text>
                : pendingUsers.map(renderUserCard)
            )}
            <SectionHeader
              label="Team"
              count={teamUsers.length}
              open={teamSectionOpen}
              onToggle={() => setTeamSectionOpen((v) => !v)}
              accent="blue.500"
            />
            {teamSectionOpen && (
              teamUsers.length === 0
                ? <Text fontSize="sm" color="fg.muted" pl={2} mb={3}>No team members match the current filters.</Text>
                : teamUsers.map(renderUserCard)
            )}
            <SectionHeader
              label="Clients"
              count={clientUsers.length}
              open={clientSectionOpen}
              onToggle={() => setClientSectionOpen((v) => !v)}
              accent="green.500"
            />
            {clientSectionOpen && (
              clientUsers.length === 0
                ? <Text fontSize="sm" color="fg.muted" pl={2} mb={3}>No clients match the current filters.</Text>
                : clientUsers.map(renderUserCard)
            )}
          </>
        );
      })()}
      <ConfirmDialog
        open={!!workerTypeConfirm}
        title="Change Worker Type"
        message={`Are you sure you want to set this worker as ${workerTypeConfirm?.workerType?.toLowerCase() ?? "unclassified"}?`}
        confirmLabel="Confirm"
        onConfirm={confirmWorkerType}
        onCancel={() => setWorkerTypeConfirm(null)}
      />
      <ConfirmDialog
        open={!!ownerConfirm}
        title={ownerConfirm?.isOwner ? "Flag as LLC Owner" : "Clear Owner Flag"}
        message={
          ownerConfirm?.isOwner
            ? `Flag ${ownerConfirm?.displayName} as the LLC owner? Their job earnings will continue to be tracked but will be EXCLUDED from Gusto payroll and QB labor-expense exports. Only one user can hold this flag.`
            : `Clear the LLC-owner flag from ${ownerConfirm?.displayName}? Future job earnings for this user will appear in Gusto/QB exports like any other worker.`
        }
        confirmLabel="Confirm"
        onConfirm={confirmOwner}
        onCancel={() => setOwnerConfirm(null)}
      />
      <ConfirmDialog
        open={!!removeWorkerConfirm}
        title="Remove Worker role?"
        message={
          removeWorkerConfirm
            ? `Remove the Worker role from ${removeWorkerConfirm.displayName}? They'll lose access to the Worker tab, can't claim jobs, can't check out equipment, and won't appear in worker assignments. Their user account stays — the role can be re-granted later. This will be blocked if they currently have any equipment reserved or checked out.`
            : ""
        }
        confirmLabel="Remove Worker"
        confirmColorPalette="red"
        onConfirm={async () => {
          const target = removeWorkerConfirm;
          setRemoveWorkerConfirm(null);
          if (target) await removeRole(target.userId, "WORKER");
        }}
        onCancel={() => setRemoveWorkerConfirm(null)}
      />

      {/* Guaranteed payout period — set/extend/clear via a single date
          picker. Dialog adapts to start vs. manage. End-early sends
          until=null, which the API writes an GUARANTEED_PAYOUT_ENDED
          audit row for. Date is bound 1-90 days from today. */}
      <Dialog.Root
        open={!!guaranteedPayoutTarget}
        onOpenChange={(e) => { if (!e.open) setGuaranteedPayoutTarget(null); }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>
                  {guaranteedPayoutTarget?.mode === "start"
                    ? "Start guaranteed payout period"
                    : "Manage guaranteed payout period"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {guaranteedPayoutTarget && (() => {
                  const u = guaranteedPayoutTarget.user;
                  const currentUntil = u.guaranteedPayoutUntil ? new Date(u.guaranteedPayoutUntil) : null;
                  // Window bounds for the picker: today (earliest allowed
                  // end date) through today + 90 days (maximum onboarding
                  // length). Operator decides anywhere inside.
                  const todayIso = new Date().toISOString().slice(0, 10);
                  const maxDateObj = new Date();
                  maxDateObj.setDate(maxDateObj.getDate() + 90);
                  const maxIso = maxDateObj.toISOString().slice(0, 10);
                  return (
                    <VStack align="stretch" gap={3}>
                      <Box p={3} bg="gray.50" borderWidth="1px" borderColor="gray.200" rounded="md">
                        <Text fontSize="sm" fontWeight="medium">{u.displayName ?? u.email ?? u.id}</Text>
                        <Text fontSize="xs" color="fg.muted">{u.email}</Text>
                      </Box>

                      {guaranteedPayoutTarget.mode === "manage" && currentUntil && (
                        <Box p={2} bg="purple.50" borderWidth="1px" borderColor="purple.200" rounded="md">
                          <Text fontSize="sm" color="purple.900">
                            Currently active through <b>{fmtDate(u.guaranteedPayoutUntil)}</b>
                            {u.guaranteedPayoutStartedAt && (
                              <> (started {fmtDate(u.guaranteedPayoutStartedAt)})</>
                            )}
                            .
                          </Text>
                        </Box>
                      )}

                      <Box>
                        <Text fontSize="xs" fontWeight="semibold" mb={1}>
                          End date (inclusive, 1–90 days from today)
                        </Text>
                        <Input
                          type="date"
                          size="sm"
                          value={guaranteedPayoutTarget.dateInput}
                          min={todayIso}
                          max={maxIso}
                          onChange={(e) => setGuaranteedPayoutTarget({
                            ...guaranteedPayoutTarget,
                            dateInput: e.target.value,
                          })}
                        />
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          Jobs the contractor completes through this date are paid
                          regardless of client payment timing. After this date the
                          standing contingent-payment terms apply automatically.
                        </Text>
                      </Box>

                      <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                        <Text fontSize="xs" color="yellow.900">
                          Make sure the contractor has signed the onboarding
                          addendum with this end date filled in before activating.
                        </Text>
                      </Box>
                    </VStack>
                  );
                })()}
              </Dialog.Body>
              <Dialog.Footer>
                <Stack direction={{ base: "column", md: "row" }} w="full" gap={2} justify="flex-end">
                  <Button
                    variant="ghost"
                    onClick={() => setGuaranteedPayoutTarget(null)}
                    disabled={guaranteedPayoutBusy}
                  >
                    Cancel
                  </Button>
                  {guaranteedPayoutTarget?.mode === "manage" && (
                    <Button
                      variant="outline"
                      colorPalette="red"
                      loading={guaranteedPayoutBusy}
                      onClick={() => void saveGuaranteedPayout(null)}
                    >
                      End early
                    </Button>
                  )}
                  <Button
                    colorPalette="purple"
                    loading={guaranteedPayoutBusy}
                    disabled={!guaranteedPayoutTarget?.dateInput}
                    onClick={() => void saveGuaranteedPayout(guaranteedPayoutTarget?.dateInput ?? null)}
                  >
                    {guaranteedPayoutTarget?.mode === "start" ? "Start period" : "Save end date"}
                  </Button>
                </Stack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

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
                    size="sm"
                    onClick={() => setShowInfoOverlay(false)}
                  >
                    Close
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
