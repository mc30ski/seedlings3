"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  SimpleGrid,
  Text,
  VStack,
  Select,
  Spinner,
  createListCollection,
  useDisclosure,
} from "@chakra-ui/react";
import { AlertCircle, AlertTriangle, BarChart3, ChevronDown, ChevronRight, ChevronUp, Copy, Eye, Filter, Hand, Heart, LayoutGrid, LayoutList, Maximize2, MoreHorizontal, Package, Pin, Plus, RefreshCw, RotateCcw, ScanLine, Share2, User, Users, X, Zap } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import { bizToday, bizAddDays, bizDateKey, fmtDateOpts, fmtDateShort } from "@/src/lib/dates";
import { prettyStatus, notifyEquipmentUpdated, extractSlug } from "@/src/lib/labels";
import { determineRoles } from "@/src/lib/roles";
import { equipmentStatusColor } from "@/src/lib/statusColors";
import { TabPropsType, EquipmentStatus, Equipment } from "@/src/lib/types";
import { onEventSearchRun } from "@/src/lib/bus";
import { resolveBillingMode, shortBillingChip, instructiveBillingText } from "@/src/lib/equipmentBilling";
import { useEquipmentBillingEnabled } from "@/src/lib/useEquipmentBillingEnabled";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import QRScannerDialog from "@/src/ui/dialogs/QRScannerDialog";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import EquipmentPhotos from "@/src/ui/components/EquipmentPhotos";
import EquipmentThumbnail from "@/src/ui/components/EquipmentThumbnail";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import EquipmentDialog from "@/src/ui/dialogs/EquipmentDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";
import { AdminViewAsSelector, AdminViewAsBadges, type AdminWorker } from "@/src/ui/tabs/JobsTab.parts";

import { EQUIPMENT_KIND, EQUIPMENT_STATUS } from "@/src/lib/types";
import { parseEquipmentKindsConfig, type EquipmentKindConfig } from "@/src/lib/equipmentSuggestions";
import { Dashboard } from "@/src/ui/components/Dashboard";
import {
  SUPER_PERIODS,
  periodKey,
  periodToRange,
} from "@/src/ui/components/WorkerHourlyPayCard";

// Kind states are now derived from loaded items (see useMemo below)

// Constant representing the status states for this entity.
const workerStatusStates = [
  "ALL",
  "CLAIMED",
  "AVAILABLE",
  "UNAVAILABLE",
] as const;
const adminStatusStates = ["ALL", ...EQUIPMENT_STATUS] as const;

// Card action bands — worker/admin/super buttons split into three
// role-labeled bands so a super sees at a glance which capability
// tier each button belongs to. Mirrors the pattern used by
// ElevatedActionRow on the Jobs tab: subtle top-bordered band with
// a leading colored badge and the wrap-flow buttons trailing.
function CardActionBands(props: {
  e: Equipment;
  loading: boolean;
  statusButtonBusyId: string;
  setStatusButtonBusyId: (v: string) => void;
  showWorkerExtras: boolean;
  showAdminExtras: boolean;
  isTrainee: boolean;
  viewAsUserId: string | null;
  viewAsUserName: string | null;
  canWorkerCheckout: boolean;
  canWorkerCancel: boolean;
  canWorkerReturn: boolean;
  canWorkerReserve: boolean;
  canAdminForceRelease: boolean;
  canAdminStartMaintenance: boolean;
  canAdminEndMaintenance: boolean;
  canAdminRetire: boolean;
  canAdminUnretire: boolean;
  canSuperHardDelete: boolean;
  canSuperReserveFor: boolean;
  canSuperCancelFor: boolean;
  canSuperCheckoutFor: boolean;
  canSuperReturnFor: boolean;
  onEdit: () => void;
  onWorkerCheckout: () => void;
  onWorkerCancel: () => void;
  onWorkerReturn: () => void;
  onWorkerReserve: () => void;
  onForceRelease: () => void;
  onStartMaintenance: () => void;
  onEndMaintenance: () => void;
  onRetire: () => void;
  onUnretire: () => void;
  onHardDelete: () => void;
  onSuperReserveFor: () => void;
  onSuperCancelFor: () => void;
  onSuperCheckoutFor: () => void;
  onSuperReturnFor: () => void;
}) {
  const {
    e, loading, statusButtonBusyId, setStatusButtonBusyId,
    showWorkerExtras, showAdminExtras, isTrainee,
    viewAsUserId, viewAsUserName,
    canWorkerCheckout, canWorkerCancel, canWorkerReturn, canWorkerReserve,
    canAdminForceRelease, canAdminStartMaintenance, canAdminEndMaintenance,
    canAdminRetire, canAdminUnretire, canSuperHardDelete,
    canSuperReserveFor, canSuperCancelFor, canSuperCheckoutFor, canSuperReturnFor,
    onEdit, onWorkerCheckout, onWorkerCancel, onWorkerReturn, onWorkerReserve,
    onForceRelease, onStartMaintenance, onEndMaintenance, onRetire, onUnretire,
    onHardDelete, onSuperReserveFor, onSuperCancelFor, onSuperCheckoutFor, onSuperReturnFor,
  } = props;

  const holderLabel = e.holder?.displayName || e.holder?.email || "holder";

  // Worker band — surfaces only when at least one worker action is
  // available (own reserve/checkout/cancel/return, or the trainee
  // gate hint). Empty band would be visual noise on admin cards with
  // nothing to reserve.
  const showTraineeHint = showWorkerExtras && e.status === "AVAILABLE" && isTrainee && !viewAsUserId;
  const showWorkerBand =
    canWorkerCheckout || canWorkerCancel || canWorkerReturn || canWorkerReserve || showTraineeHint;
  // Admin band always renders when scope includes admin — the "Edit"
  // button anchors it, and the other Admin buttons appear as their
  // per-status guards permit.
  const showSuperBand =
    canSuperReserveFor || canSuperCancelFor || canSuperCheckoutFor || canSuperReturnFor || canSuperHardDelete;

  if (!showWorkerBand && !showAdminExtras && !showSuperBand) return null;

  const bandProps = {
    px: 3, py: 1.5, gap: 2, wrap: "wrap" as const,
    borderTopWidth: "1px", borderColor: "blackAlpha.100",
    bg: "blackAlpha.50",
  };

  return (
    <VStack align="stretch" gap={0}>
      {showWorkerBand && (
        <HStack {...bandProps}>
          {/* Worker band leading label — only shows the "Acting as X"
              chip when admin has view-as active, since that context is
              load-bearing. In the normal (own-scope) case the buttons
              stand alone, matching how "own" actions read across the
              rest of the app. */}
          {viewAsUserId && (
            <Badge size="xs" variant="subtle" colorPalette="cyan">
              <Eye size={9} style={{ marginRight: 3 }} />
              <Text as="span">Acting as {viewAsUserName ?? "worker"}</Text>
            </Badge>
          )}
          {canWorkerReserve && (
            <StatusButton id="equipment-reserve" itemId={e.id} label="Reserve" onClick={async () => onWorkerReserve()}
              variant="solid" colorPalette="green" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canWorkerCheckout && (
            <StatusButton id="equipment-checkout" itemId={e.id} label="Check Out" onClick={async () => onWorkerCheckout()}
              variant="solid" colorPalette="blue" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canWorkerReturn && (
            <StatusButton id="equipment-return" itemId={e.id} label="Return" onClick={async () => onWorkerReturn()}
              variant="solid" colorPalette="orange" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canWorkerCancel && (
            <StatusButton id="equipment-cancel" itemId={e.id} label="Cancel Reservation" onClick={async () => onWorkerCancel()}
              variant="outline" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {showTraineeHint && (
            <HStack gap={1} fontSize="xs" color="gray.500"><AlertTriangle size={12} /><Text>Trainees cannot reserve equipment</Text></HStack>
          )}
        </HStack>
      )}
      {showAdminExtras && (
        <HStack {...bandProps}>
          <Badge size="xs" variant="subtle" colorPalette="purple">Admin</Badge>
          <StatusButton id="equipment-edit" itemId={e.id} label="Edit" onClick={async () => onEdit()}
            variant="outline" disabled={loading}
            busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          {canAdminForceRelease && (
            <StatusButton id="equipment-forceRelease" itemId={e.id} label="Force release" onClick={async () => onForceRelease()}
              variant="solid" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canAdminStartMaintenance && (
            <StatusButton id="equipment-startMaintenance" itemId={e.id} label="Start maintenance" onClick={async () => onStartMaintenance()}
              variant="subtle" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canAdminEndMaintenance && (
            <StatusButton id="equipment-endMaintenance" itemId={e.id} label="End maintenance" onClick={async () => onEndMaintenance()}
              variant="subtle" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canAdminRetire && (
            <StatusButton id="equipment-retire" itemId={e.id} label="Retire" onClick={async () => onRetire()}
              variant="outline" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canAdminUnretire && (
            <StatusButton id="equipment-unretire" itemId={e.id} label="Unretire" onClick={async () => onUnretire()}
              variant="subtle" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
        </HStack>
      )}
      {showSuperBand && (
        <HStack {...bandProps}>
          <Badge size="xs" variant="subtle" colorPalette="orange">
            <HStack gap={0.5}><Zap size={9} /><Text>Super</Text></HStack>
          </Badge>
          {canSuperReserveFor && (
            <StatusButton id="equipment-super-reserve-for" itemId={e.id} label="Reserve for worker…"
              onClick={async () => onSuperReserveFor()}
              variant="subtle" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSuperCancelFor && (
            <StatusButton id="equipment-super-cancel-for" itemId={e.id} label={`Cancel for ${holderLabel}`}
              onClick={async () => onSuperCancelFor()}
              variant="subtle" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSuperCheckoutFor && (
            <StatusButton id="equipment-super-checkout-for" itemId={e.id} label={`Checkout for ${holderLabel}`}
              onClick={async () => onSuperCheckoutFor()}
              variant="solid" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSuperReturnFor && (
            <StatusButton id="equipment-super-return-for" itemId={e.id} label={`Return for ${holderLabel}`}
              onClick={async () => onSuperReturnFor()}
              variant="solid" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSuperHardDelete && (
            <StatusButton id="equipment-hardDelete" itemId={e.id} label="Delete" onClick={async () => onHardDelete()}
              variant="danger-outline" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
        </HStack>
      )}
    </VStack>
  );
}

type InventoryTabProps = TabPropsType & {
  /** Additive scope — capabilities ADD as you climb the ladder.
   *  scope.isWorker → like/pin/reserve-for-self/reserve-for-group/kit
   *  scope.isAdmin  → adds edit/force-release/maintenance/retire/insights/…
   *  scope.isSuper  → adds reserve-for/checkout-for/return-for/hard-delete
   *  Falls back to the legacy `purpose` prop when not passed. */
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
};

export default function InventoryTab({ me, purpose = "WORKER", scope }: InventoryTabProps) {
  const { isSuper: hasSuperRole, isAvail, forAdmin } = determineRoles(me, purpose);

  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from `purpose` for any callsite still on the old shape.
  const effScope = scope ?? {
    isWorker: purpose === "WORKER",
    isAdmin: purpose === "ADMIN" || purpose === "SUPER",
    isSuper: purpose === "SUPER",
  };
  // Capabilities render additively AND are strictly governed by the
  // scope prop — not by the underlying role. A user with admin+super
  // roles viewing the *Admin* tab must NOT see Super buttons (that's
  // what the Super top-tab is for). Super scope inherits Admin
  // capabilities so a super sees admin controls too.
  const showWorkerExtras = effScope.isWorker;
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  const showSuperExtras = effScope.isSuper && hasSuperRole;

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  // Persisted-state prefix: worker-only view gets its own bucket so
  // filters don't collide with an admin/super view on the same device.
  const pfx = showAdminExtras ? "equip_a" : "equip_w";
  const [compact, setCompact] = usePersistedState(`${pfx}_compact`, false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(
    `${pfx}_status`, showAdminExtras ? ["ALL"] : ["CLAIMED"]
  );
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);
  const [likedOnly, setLikedOnly] = usePersistedState<boolean>(`${pfx}_likedOnly`, false);
  // Admin-only "filter to a specific worker" — pre-set externally from HomeTab tile
  // click-throughs so the Equipment tab shows only what that worker has reserved/checked
  // out. Multi-select array to mirror JobsTab's pattern.
  const [workerFilter, setWorkerFilter] = usePersistedState<string[]>(
    `${pfx}_workers`, [],
  );

  // Admin "view as" — pick a worker's context so the worker-side
  // reserve/checkout affordances execute on their behalf via the
  // super endpoints. Persisted so a mid-session refresh keeps the
  // active workers in view.
  const [viewAsUserIds, setViewAsUserIds] = usePersistedState<string[]>(
    "inventoryTab_viewAsIds", [],
  );
  const viewAsUserId = viewAsUserIds[0] ?? null;

  // `isWorkerView` — retained for existing callsites; means "the
  // worker-facing affordances are showing on this render". Now driven
  // by additive scope.
  const isWorkerView = showWorkerExtras;
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  // Global "refreshing all sections" flag — set by the toolbar refresh
  // button and cleared after a fixed window. Drives the tab-body dim
  // + spinning icon so users see feedback even for sections that are
  // currently collapsed (their internal spinner would be invisible).
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [items, setItems] = useState<Equipment[]>([]);
  const [equipmentKinds, setEquipmentKinds] = useState<EquipmentKindConfig[]>([]);
  // Master toggle EQUIPMENT_BILLING_ENABLED — when OFF every billing
  // chip + reserve-confirmation text renders $0.00/day instead of the
  // configured rate. See lib/useEquipmentBillingEnabled.
  const equipmentBillingEnabled = useEquipmentBillingEnabled();
  // Equipment Collections — kits the admin has defined. Workers see them at
  // the top of the tab as "Reserve kit" shortcuts; the action loops the
  // existing per-piece reserve() call.
  type CollectionItem = { id: string; equipmentId: string; equipment: { id: string; shortDesc?: string | null; type?: string | null; brand?: string | null; model?: string | null; status?: string | null; retiredAt?: string | null } };
  type Collection = { id: string; name: string; description?: string | null; items: CollectionItem[] };
  const [collections, setCollections] = useState<Collection[]>([]);
  // Per-card expansion state for collection cards. Click the chevron to reveal
  // the description + member equipment list (matches what the Equipment
  // Collections admin tab shows for each kit).
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());
  const [reservingKitId, setReservingKitId] = useState<string | null>(null);
  // Partial-availability confirm dialog state — opens when the user
  // taps Reserve on a collection whose members are not all AVAILABLE.
  // Shows what CAN be reserved + what's blocking each excluded piece,
  // lets the caller confirm the partial checkout or bail.
  type KitPartial = {
    collection: Collection;
    available: CollectionItem[];
    unavailable: { item: CollectionItem; reason: string }[];
    opts: { groupId?: string | null };
  };
  const [kitPartialConfirm, setKitPartialConfirm] = useState<KitPartial | null>(null);
  const [collectionsCollapsed, setCollectionsCollapsed] = usePersistedState<boolean>(`${pfx}_collectionsCollapsed`, false);
  const [usageCollapsed, setUsageCollapsed] = usePersistedState<boolean>(`${pfx}_usageCollapsed`, true);
  const [teamUsageCollapsed, setTeamUsageCollapsed] = usePersistedState<boolean>(`${pfx}_teamUsageCollapsed`, true);
  const [highlightCollectionId, setHighlightCollectionId] = useState<string | null>(null);
  const [equipmentCollapsed, setEquipmentCollapsed] = usePersistedState<boolean>(`${pfx}_equipmentCollapsed`, false);
  // Track filter-active transitions so we can auto-collapse the Collections
  // strip when the user starts narrowing the equipment list.
  const filtersActiveRef = useRef(false);
  // Filter the equipment list to members of a single collection. Workers use
  // it to drill into "what's in this kit"; admins use it to scope bulk actions
  // like force-release.
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null);

  // Groups this user is the claimer of — used to surface the "Reserve on
  // behalf of [Group]" picker. Only group claimers can rent equipment for
  // a group; cost gets split across workers per the group's percent config.
  type ClaimerGroup = { id: string; name: string; members: { userId: string }[] };
  const [groupsAsClaimer, setGroupsAsClaimer] = useState<ClaimerGroup[]>([]);
  // Tri-state: null = nothing selected yet, "" = Just me, "<id>" = group.
  // Not persisted: every fresh visit starts unselected so workers have to
  // make a conscious choice before reserving. Chip clicks from JobsTab
  // pre-fill this via the sessionStorage handoff so the worker doesn't
  // have to pick again on every chip click.
  const [reserveForGroupId, setReserveForGroupId] = useState<string | null>(null);
  const [reserveScopePromptFor, setReserveScopePromptFor] = useState<
    | { kind: "single"; equipment: Equipment }
    | { kind: "collection"; collection: Collection }
    | null
  >(null);
  useEffect(() => {
    // Fetch the caller's crew-lead groups regardless of scope. Admins
    // who are ALSO workers (dual-role) should see their group card in
    // admin view too — the endpoint returns [] for admin-only users so
    // this is a no-op for them.
    if (!showWorkerExtras) return;
    apiGet<ClaimerGroup[]>("/api/me/groups-as-claimer")
      .then((list) => {
        const groups = Array.isArray(list) ? list : [];
        setGroupsAsClaimer(groups);
        // Stale-state guard: if a group id was hinted/chosen but the
        // group doesn't exist anymore (e.g. after a reseed), drop back
        // to the unselected state so the reserve flow prompts again.
        if (reserveForGroupId && !groups.some((g) => g.id === reserveForGroupId)) {
          setReserveForGroupId(null);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWorkerExtras]);

  // Hand-off from JobsTab: when a worker clicks a preferred-equipment chip
  // on a group-claimed job, the chip sets `reserveAsGroupId` so the picker
  // here lands on the right group without a manual click. Reads + clears
  // on mount and on every navigate-to-equipment event (so the same handoff
  // works even if EquipmentTab is already mounted in the background).
  const applyReserveAsGroupHandoff = () => {
    try {
      const hint = window.sessionStorage.getItem("reserveAsGroupId");
      if (hint != null) {
        window.sessionStorage.removeItem("reserveAsGroupId");
        setReserveForGroupId(hint);
      }
    } catch {}
  };
  useEffect(() => { applyReserveAsGroupHandoff(); }, []);
  // Workers list — only used by the admin worker-filter chip to look up names.
  const [adminWorkers, setAdminWorkers] = useState<Array<{ id: string; displayName?: string | null; email?: string | null }>>([]);
  useEffect(() => {
    if (!showAdminExtras) return;
    apiGet<Array<{ id: string; displayName?: string | null; email?: string | null }>>("/api/workers")
      .then((list) => setAdminWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [showAdminExtras]);
  const adminWorkerName = (id: string) => {
    const w = adminWorkers.find((x) => x.id === id);
    return w?.displayName || w?.email || id.slice(0, 6);
  };

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  // Scan-to-find: opens the QR scanner just to drop the slug into the
  // search box, locating the item in the list without checking it out.
  const [scanSearchOpen, setScanSearchOpen] = useState(false);
  // Check-in ("Return") no longer requires a QR scan — a confirm dialog
  // stands in as the deliberate-action guard. The physical-sticker scan
  // path (/e/[slug] → qrAction) is unaffected.
  const [returnConfirmEquip, setReturnConfirmEquip] = useState<Equipment | null>(null);
  const [reserveConfirmEquip, setReserveConfirmEquip] = useState<Equipment | null>(null);
  const [reserveChecked, setReserveChecked] = useState(false);
  const [qrAction, setQrAction] = useState<{ equipmentId: string; slug: string; action: "checkout" | "return"; label: string } | null>(null);
  const [qrActionBusy, setQrActionBusy] = useState(false);

  // Super "act on behalf of a worker" state. When `action === "reserve"`
  // the dialog includes a worker picker (the worker isn't already implied
  // by an active checkout). For the other three actions the current holder
  // is the implied target, so the dialog is just a confirm.
  const [superActionFor, setSuperActionFor] = useState<
    | { equipment: Equipment; action: "reserve" | "cancel" | "checkout" | "return" }
    | null
  >(null);
  const [superPickerUserId, setSuperPickerUserId] = useState<string>("");
  const [superActionBusy, setSuperActionBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Listen for external filter requests (e.g., from HomeTab tiles).
  // Reset all "what's shown" filters first, then apply only the values present in the event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setStatusFilter(["ALL"]);
      setKind(["ALL"]);
      setLikedOnly(false);
      setQ("");
      if (typeof detail.status === "string") setStatusFilter([detail.status]);
      if (typeof detail.kind === "string") setKind([detail.kind]);
      if (detail.likedOnly === true) setLikedOnly(true);
      if (typeof detail.q === "string") setQ(detail.q);
    };
    window.addEventListener("equipment:applyFilter", handler as EventListener);
    return () => window.removeEventListener("equipment:applyFilter", handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper variable to disable other buttons while actions are in flight.
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Derive equipment kinds from config + loaded items + hardcoded fallback
  const kindItems = useMemo(() => {
    const labelMap = new Map<string, string>();
    // Config kinds first (preserves config order)
    for (const k of equipmentKinds) labelMap.set(k.key, k.label);
    // Hardcoded fallback
    for (const k of EQUIPMENT_KIND) if (!labelMap.has(k)) labelMap.set(k, prettyStatus(k));
    // Any types from actual items not yet in map
    for (const i of items) if (i.type && !labelMap.has(i.type)) labelMap.set(i.type, prettyStatus(i.type));
    return [{ label: "All Kinds", value: "ALL" }, ...[...labelMap.entries()].map(([value, label]) => ({ label, value }))];
  }, [items, equipmentKinds]);
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  const statusItems = useMemo(
    () =>
      (forAdmin ? adminStatusStates : workerStatusStates).map((s) => ({
        label: s === "ALL" ? "All Statuses" : prettyStatus(s),
        value: s,
      })),
    [forAdmin]
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  // Worker picker collection — Super "act on behalf of" dialog uses this to
  // pick the target worker for a reserve action. Sorted by display name.
  const superWorkerItems = useMemo(
    () =>
      adminWorkers
        .slice()
        .sort((a, b) =>
          (a.displayName || a.email || "").localeCompare(
            b.displayName || b.email || "",
          ),
        )
        .map((w) => ({
          label: w.displayName || w.email || w.id.slice(0, 8),
          value: w.id,
        })),
    [adminWorkers],
  );
  const superWorkerCollection = useMemo(
    () => createListCollection({ items: superWorkerItems }),
    [superWorkerItems],
  );

  // Main function to load all the items from the API.
  async function load(displayLoading: boolean = true) {
    setLoading(displayLoading);
    try {
      const list: Equipment[] = await apiGet("/api/equipment/all");
      setItems(list.sort((a, b) => a.shortDesc.localeCompare(b.shortDesc)));
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load equipment", err),
      });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  // Consume hand-off keys from sessionStorage and apply filters/highlights.
  // Extracted so the same logic runs on initial mount AND whenever this tab
  // is navigated to from elsewhere (e.g. clicking a chip on JobsTab while
  // the Equipment tab is already mounted — without this re-run, the chip
  // would switch tabs but the filter wouldn't apply because the original
  // mount effect ran with no key present).
  const applyHandoffFilters = () => {
    try {
      // Reset filters that could hide the chip-target. Any pre-existing
      // status/like/worker filter is intentionally cleared — clicking a
      // suggestion chip is an explicit "show me this thing", and the
      // user's prior narrowing context shouldn't compete with it.
      const resetFiltersForHandoff = () => {
        setQ("");
        setKind(["ALL"]);
        setStatusFilter(["ALL"]);
        setCollectionFilter(null);
        if (isWorkerView) setLikedOnly(false);
        if (forAdmin) setWorkerFilter([]);
      };

      const hl = window.sessionStorage.getItem("highlightCollectionId");
      if (hl) {
        window.sessionStorage.removeItem("highlightCollectionId");
        resetFiltersForHandoff();
        setHighlightCollectionId(hl);
        setCollectionsCollapsed(false);
        setExpandedCollections((prev) => {
          const next = new Set(prev);
          next.add(hl);
          return next;
        });
        setTimeout(() => setHighlightCollectionId(null), 2500);
      }
      const highlight = window.sessionStorage.getItem("equipmentHighlightId");
      if (highlight) {
        window.sessionStorage.removeItem("equipmentHighlightId");
        resetFiltersForHandoff();
        setHighlightId(highlight);
      }
      const kindOverride = window.sessionStorage.getItem("equipmentKindFilter");
      if (kindOverride) {
        window.sessionStorage.removeItem("equipmentKindFilter");
        resetFiltersForHandoff();
        setKind([kindOverride]);
      }
      // Reserve-scope handoff lives alongside the filter handoffs so the
      // same chip click can both highlight the equipment AND switch the
      // reserve picker to the right group.
      const groupHint = window.sessionStorage.getItem("reserveAsGroupId");
      if (groupHint != null) {
        window.sessionStorage.removeItem("reserveAsGroupId");
        setReserveForGroupId(groupHint);
      }
    } catch {}
  };

  // Loads all the items for the first time. Also re-runs whenever the
  // admin's view-as picker changes so the list reflects the target
  // worker's holdings and status filters resolve correctly.
  useEffect(() => {
    void load();
    const settingsPath = showAdminExtras ? "/api/admin/settings" : "/api/settings";
    apiGet<any[]>(settingsPath)
      .then((list) => {
        if (!Array.isArray(list)) return;
        const ek = list.find((r: any) => r.key === "EQUIPMENT_KINDS");
        if (ek?.value) { const parsed = parseEquipmentKindsConfig(ek.value); if (parsed) setEquipmentKinds(parsed); }
      })
      .catch(() => {});
    apiGet<Collection[]>("/api/equipment-collections")
      .then((list) => setCollections(Array.isArray(list) ? list : []))
      .catch(() => setCollections([]));
    applyHandoffFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAdminExtras, viewAsUserId]);

  // Re-apply hand-off filters whenever someone navigates to this tab.
  // The chip click sets sessionStorage *then* dispatches the navigate
  // event, so by the time this handler runs the key is present. Super
  // scope dispatches its own event to keep cross-tab wiring correct
  // (previously piggybacked on navigate:adminTab which routed super
  // clicks to the admin inner-tab space).
  useEffect(() => {
    const eventName =
      showSuperExtras
        ? "navigate:superTab"
        : showAdminExtras
          ? "navigate:adminTab"
          : "navigate:workerTab";
    function handler(ev: Event) {
      const detail = (ev as CustomEvent).detail;
      if (detail?.tab !== "equipment") return;
      applyHandoffFilters();
    }
    window.addEventListener(eventName, handler as EventListener);
    return () => window.removeEventListener(eventName, handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSuperExtras, showAdminExtras]);

  // Worker-only: load pinned + liked equipment
  useEffect(() => {
    if (!isWorkerView) return;
    apiGet<string[]>("/api/equipment/pinned")
      .then((ids) => setPinnedIds(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => {});
    apiGet<string[]>("/api/equipment/liked")
      .then((ids) => setLikedIds(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => {});
  }, [isWorkerView]);

  // Deep-link: highlight a specific equipment item (from share link)
  useEffect(() => {
    (window as any).__equipmentTabReady = true;
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ equipmentId: string }>).detail?.equipmentId;
      if (!id) return;
      setHighlightId(id);
      setQ("");
      setKind(["ALL"]);
      setStatusFilter(["ALL"]);
      setExpandedCards(new Set([id]));
    };
    window.addEventListener("equipmentTab:highlight", handler);
    return () => {
      (window as any).__equipmentTabReady = false;
      window.removeEventListener("equipmentTab:highlight", handler);
    };
  }, []);

  async function togglePin(equipmentId: string) {
    const wasPinned = pinnedIds.has(equipmentId);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (wasPinned) next.delete(equipmentId);
      else next.add(equipmentId);
      return next;
    });
    try {
      await apiPost(`/api/equipment/${equipmentId}/${wasPinned ? "unpin" : "pin"}`);
      publishInlineMessage({ type: "SUCCESS", text: wasPinned ? "Unpinned" : "Pinned", icon: Pin, autoHideMs: 1500 });
    } catch (err) {
      setPinnedIds((prev) => {
        const next = new Set(prev);
        if (wasPinned) next.add(equipmentId);
        else next.delete(equipmentId);
        return next;
      });
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Pin failed.", err) });
    }
  }

  async function toggleLike(equipmentId: string) {
    const wasLiked = likedIds.has(equipmentId);
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (wasLiked) next.delete(equipmentId);
      else next.add(equipmentId);
      return next;
    });
    try {
      await apiPost(`/api/equipment/${equipmentId}/${wasLiked ? "unlike" : "like"}`);
      publishInlineMessage({ type: "SUCCESS", text: wasLiked ? "Unliked" : "Liked", icon: Heart, autoHideMs: 1500 });
    } catch (err) {
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (wasLiked) next.add(equipmentId);
        else next.delete(equipmentId);
        return next;
      });
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Like failed.", err) });
    }
  }

  function shareEquipmentLink(equipmentId: string) {
    const url = `${window.location.origin}/?equipment=${equipmentId}${forAdmin ? "&view=admin" : ""}`;
    navigator.clipboard.writeText(url).then(() => {
      publishInlineMessage({ type: "SUCCESS", text: "Link copied to clipboard." });
    }).catch(() => {
      publishInlineMessage({ type: "ERROR", text: "Failed to copy link." });
    });
  }

  function ActionIcons({ equipmentId }: { equipmentId: string }) {
    const isOpen = openActionMenuId === equipmentId;
    const isLiked = likedIds.has(equipmentId);
    const isPinned = pinnedIds.has(equipmentId);
    return (
      <Box position="relative" flexShrink={0}>
        <Button
          variant="ghost"
          size="xs"
          px="1"
          minW="0"
          onClick={(ev) => {
            ev.stopPropagation();
            setOpenActionMenuId(isOpen ? null : equipmentId);
          }}
          title="More actions"
        >
          <MoreHorizontal size={16} />
        </Button>
        {isOpen && (
          <>
            <Box
              position="fixed"
              inset="0"
              zIndex={9999}
              onClick={(ev) => { ev.stopPropagation(); setOpenActionMenuId(null); }}
            />
            <VStack
              position="fixed"
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              rounded="md"
              shadow="lg"
              zIndex={10000}
              p={1}
              gap={0}
              minW="140px"
              align="stretch"
              onClick={(ev) => ev.stopPropagation()}
              ref={(el: HTMLDivElement | null) => {
                if (el && el.parentElement) {
                  const rect = el.parentElement.getBoundingClientRect();
                  el.style.top = `${rect.bottom + 4}px`;
                  el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`;
                }
              }}
            >
              {isWorkerView && (
                <>
                  <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setOpenActionMenuId(null); void toggleLike(equipmentId); }}>
                    <Heart size={14} fill={isLiked ? "var(--chakra-colors-red-500)" : "none"} color="var(--chakra-colors-red-500)" />
                    <Box as="span" ml={2}>{isLiked ? "Unlike" : "Like"}</Box>
                  </Button>
                  <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setOpenActionMenuId(null); void togglePin(equipmentId); }}>
                    <Pin size={14} fill={isPinned ? "currentColor" : "none"} />
                    <Box as="span" ml={2}>{isPinned ? "Unpin" : "Pin"}</Box>
                  </Button>
                </>
              )}
              <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setOpenActionMenuId(null); shareEquipmentLink(equipmentId); }}>
                <Share2 size={14} />
                <Box as="span" ml={2}>Share link</Box>
              </Button>
            </VStack>
          </>
        )}
      </Box>
    );
  }

  useEffect(() => {
    onEventSearchRun("activityTavToEquipmentTabQRCodeSearch", setQ, inputRef);
  }, []);

  // QR slug redirect (from /e/[slug] page) — kept separate from the
  // applyHandoffFilters helper because it also drives the
  // post-load checkout/return prompt via qrSlugPending.current.
  const qrSlugPending = useRef<string | null>(null);
  useEffect(() => {
    const qrSlug = window.sessionStorage.getItem("equipmentQrSlug");
    if (qrSlug) {
      window.sessionStorage.removeItem("equipmentQrSlug");
      qrSlugPending.current = qrSlug;
      setQ(qrSlug);
      setKind(["ALL"]);
      setStatusFilter(["ALL"]);
    }
  }, []);

  // Auto-collapse the Collections strip when the user starts filtering.
  // Triggers on the no-filters → any-filters transition; the user can still
  // manually re-expand and that override sticks until filters are cleared.
  useEffect(() => {
    const hasFilters =
      !!q.trim()
      || kind[0] !== "ALL"
      || statusFilter[0] !== "ALL"
      || (isWorkerView && likedOnly)
      || (forAdmin && workerFilter.length > 0)
      || !!collectionFilter
      || !!highlightId;
    if (hasFilters && !filtersActiveRef.current) {
      setCollectionsCollapsed(true);
    }
    filtersActiveRef.current = hasFilters;
  }, [q, kind, statusFilter, likedOnly, workerFilter, collectionFilter, highlightId, isWorkerView, forAdmin]);
  // Once items are loaded, match the slug and show action dialog
  useEffect(() => {
    if (!qrSlugPending.current || items.length === 0) return;
    const slug = qrSlugPending.current;
    const match = items.find((e) => e.qrSlug?.toLowerCase() === slug.toLowerCase());
    if (!match) return;
    qrSlugPending.current = null;
    // Check equipment status to determine action
    if (match.status === "RESERVED") {
      // User has it reserved — offer checkout
      setQrAction({ equipmentId: match.id, slug, action: "checkout", label: `Check out "${match.shortDesc || match.brand + " " + match.model}"?` });
    } else if (match.status === "CHECKED_OUT") {
      // User has it checked out — offer return
      setQrAction({ equipmentId: match.id, slug, action: "return", label: `Return "${match.shortDesc || match.brand + " " + match.model}"?` });
    }
  }, [items]);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    let rows = items;

    // Deep-link: filter to a single equipment item.
    if (highlightId) {
      rows = rows.filter((r) => r.id === highlightId);
      return rows;
    }

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.type === kind[0]);
    }

    const sf = statusFilter[0];
    if (sf !== "ALL") {
      let want: EquipmentStatus[] | null = null;
      if (forAdmin) {
        want = [sf as EquipmentStatus];
      } else {
        switch (sf) {
          case "CLAIMED":
            want = ["RESERVED", "CHECKED_OUT"];
            break;
          case "AVAILABLE":
            want = ["AVAILABLE"];
            break;
          case "UNAVAILABLE":
            want = ["RESERVED", "CHECKED_OUT", "MAINTENANCE"];
            break;
          case "MY_RESERVED":
            // Filter to user's reserved-only items (not yet checked out)
            rows = rows.filter((r) => r.status === "RESERVED" && !!me && r.holder?.userId === me.id);
            break;
          case "MY_CHECKED_OUT":
            rows = rows.filter((r) => r.status === "CHECKED_OUT" && !!me && r.holder?.userId === me.id);
            break;
        }
      }
      if (want) rows = rows.filter((r) => r.status && want!.includes(r.status));
    }
    // Filter based on free text.
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const who =
          r.holder?.displayName?.toLowerCase() ||
          r.holder?.email?.toLowerCase() ||
          "";
        const arr = [
          r.status || "",
          r.brand || "",
          r.model || "",
          r.shortDesc || "",
          r.longDesc || "",
          r.type || "",
          r.energy || "",
          r.features || "",
          r.condition || "",
          r.issues || "",
          r.age || "",
          r.qrSlug || "",
          who,
        ];
        return arr.map((i) => i.toLowerCase()).some((i) => i.includes(qlc));
      });
    }

    // Liked-only filter (worker)
    if (isWorkerView && likedOnly) {
      rows = rows.filter((r) => likedIds.has(r.id));
    }

    // Worker filter (admin) — show only equipment whose current holder is one of the
    // selected workers. Items with no holder fall out, since the filter is "what does
    // worker X have right now."
    if (forAdmin && workerFilter.length > 0) {
      const ids = new Set(workerFilter);
      rows = rows.filter((r) => !!r.holder?.userId && ids.has(r.holder.userId));
    }

    // Restrict to members of the selected collection (worker + admin).
    if (collectionFilter) {
      const c = collections.find((x) => x.id === collectionFilter);
      const memberIds = new Set((c?.items ?? []).map((i) => i.equipmentId));
      rows = rows.filter((r) => memberIds.has(r.id));
    }

    return rows;
  }, [items, q, kind, statusFilter, forAdmin, isWorkerView, likedOnly, likedIds, highlightId, workerFilter, collectionFilter, collections]);

  // Split into Pinned + Claimed + Available + Unavailable groups (worker view only).
  const groups = useMemo(() => {
    if (!isWorkerView) {
      return [{ key: "all", label: null as string | null, items: filtered }];
    }
    const pinned: Equipment[] = [];
    const claimed: Equipment[] = [];
    const available: Equipment[] = [];
    const unavailable: Equipment[] = [];
    for (const e of filtered) {
      if (pinnedIds.has(e.id)) pinned.push(e);
      else if (!!me && e.holder?.userId === me.id && (e.status === "RESERVED" || e.status === "CHECKED_OUT")) claimed.push(e);
      else if (e.status === "AVAILABLE") available.push(e);
      else unavailable.push(e);
    }
    const out: { key: string; label: string | null; items: Equipment[] }[] = [];
    if (pinned.length > 0) out.push({ key: "pinned", label: "Pinned", items: pinned });
    if (claimed.length > 0) out.push({ key: "claimed", label: "Claimed", items: claimed });
    if (available.length > 0) out.push({ key: "available", label: "Available", items: available });
    if (unavailable.length > 0) out.push({ key: "unavailable", label: "Unavailable", items: unavailable });
    return out;
  }, [filtered, pinnedIds, isWorkerView, me]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(p: Equipment) {
    setEditing(p);
    setDialogOpen(true);
  }

  async function checkoutVerifiedWithSlug(id: string, slug: string) {
    try {
      // Admin view-as: bypass the worker's own endpoint and route the
      // checkout through the super endpoint with the picked worker id.
      if (viewAsUserId && showAdminExtras) {
        await apiPost(`/api/super/equipment/${id}/checkout-for/verify`, {
          userId: viewAsUserId,
          slug: extractSlug(slug),
        });
      } else {
        await apiPost(`/api/equipment/${id}/checkout/verify`, {
          slug: extractSlug(slug),
        });
      }
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${slug}' successfully checked in.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${slug}' checked in failed.`, err),
      });
    }
  }
  // Check-in: no QR slug sent — the server skips the scan verification
  // when the slug is absent (see equipment.returnWithQr). View-as
  // sends the equipment's own qrSlug through the super endpoint so the
  // scan-verify check inside the service still passes.
  async function doReturn(e: Equipment) {
    setStatusButtonBusyId(`equipment-return${e.id}`);
    try {
      if (viewAsUserId && showAdminExtras) {
        await apiPost(`/api/super/equipment/${e.id}/return-for/verify`, {
          userId: viewAsUserId,
          slug: e.qrSlug,
        });
      } else {
        await apiPost(`/api/equipment/${e.id}/return/verify`, {});
      }
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug ?? e.shortDesc}' successfully returned.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug ?? e.shortDesc}' return failed.`, err),
      });
    } finally {
      setStatusButtonBusyId("");
    }
  }
  async function reserve(e: Equipment) {
    // Always confirm scope for reservers who lead any group(s) — the
    // dialog opens with whatever's currently in the "Reserve as:" picker
    // pre-selected so they're just confirming, unless they want to switch.
    // Solo-only workers (no claimer-groups) skip the dialog entirely.
    if (groupsAsClaimer.length > 0) {
      setReserveScopePromptFor({ kind: "single", equipment: e });
      return;
    }
    await doReserve(e);
  }

  // The dialog-confirmed reserve path: skips the scope prompt and uses
  // whatever the caller has set in reserveForGroupId. Public reserve()
  // routes through the prompt; the prompt's button handlers call this
  // directly so we don't loop back into the dialog.
  async function doReserve(e: Equipment, opts?: { groupId?: string | null }) {
    const groupId = opts?.groupId !== undefined ? opts.groupId : reserveForGroupId;
    try {
      if (viewAsUserId && showAdminExtras) {
        // Admin view-as: reserve on behalf of the picked worker via
        // the super endpoint. Group scope is only meaningful for the
        // actual worker (who leads groups), so we drop groupId here.
        await apiPost(`/api/super/equipment/${e.id}/reserve-for`, {
          userId: viewAsUserId,
        });
      } else {
        await apiPost(`/api/equipment/${e.id}/reserve`, groupId ? { groupId } : {});
      }
      notifyEquipmentUpdated();
      await load(false);
      const groupName = groupsAsClaimer.find((g) => g.id === groupId)?.name;
      const asName = viewAsUserId ? adminWorkerName(viewAsUserId) : null;
      publishInlineMessage({
        type: "SUCCESS",
        text: asName
          ? `Reserved '${e.qrSlug}' on behalf of ${asName}.`
          : groupName
          ? `Reserved '${e.qrSlug}' on behalf of ${groupName}.`
          : `Equipment '${e.qrSlug}' successfully reserved.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug}' reserved failed.`, err),
        // POLICIES_REQUIRED is handled by PolicyGateInterceptor's dialog;
        // publishInlineMessage suppresses toasts for that code so the
        // worker only sees one surface.
        code: (err as { code?: string })?.code,
      });
    }
  }

  // Reserve every available member of a collection. Captures the actual reason
  // each member couldn't be reserved (insurance, already in use, retired, etc.)
  // and surfaces those reasons in the toast — workers shouldn't have to read
  // the console to figure out why a kit only partially reserved.
  async function reserveKit(collection: Collection) {
    // Same confirmation as the single-item reserve.
    if (groupsAsClaimer.length > 0) {
      setReserveScopePromptFor({ kind: "collection", collection });
      return;
    }
    await doReserveKit(collection);
  }

  // Split each kit member into "reservable now" vs "blocked" based on
  // the LIVE equipment status from the parent `items` state. Reason
  // strings are the same short labels shown in the partial-confirm
  // dialog + the post-reserve toast.
  function computeKitAvailability(collection: Collection): {
    available: CollectionItem[];
    unavailable: { item: CollectionItem; reason: string }[];
  } {
    const available: CollectionItem[] = [];
    const unavailable: { item: CollectionItem; reason: string }[] = [];
    for (const i of collection.items) {
      const live = items.find((eq) => eq.id === i.equipmentId);
      if (!live) {
        unavailable.push({ item: i, reason: "not found" });
        continue;
      }
      if (live.retiredAt) {
        unavailable.push({ item: i, reason: "retired" });
        continue;
      }
      if (live.status === "AVAILABLE") {
        available.push(i);
        continue;
      }
      if (live.status === "RESERVED" || live.status === "CHECKED_OUT") {
        unavailable.push({ item: i, reason: "already in use" });
      } else if (live.status === "MAINTENANCE") {
        unavailable.push({ item: i, reason: "in maintenance" });
      } else {
        unavailable.push({ item: i, reason: "not available" });
      }
    }
    return { available, unavailable };
  }

  async function doReserveKit(collection: Collection, opts?: { groupId?: string | null }) {
    const groupId = opts?.groupId !== undefined ? opts.groupId : reserveForGroupId;
    const { available, unavailable } = computeKitAvailability(collection);
    // Nothing to reserve — surface why, don't touch the API.
    if (available.length === 0) {
      const reasonCounts: Record<string, number> = {};
      for (const u of unavailable) reasonCounts[u.reason] = (reasonCounts[u.reason] ?? 0) + 1;
      const reasonText = Object.entries(reasonCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([msg, n]) => (Object.keys(reasonCounts).length === 1 ? msg : `${msg} (${n})`))
        .join(", ");
      publishInlineMessage({ type: "WARNING", text: `${collection.name}: nothing reserved — ${reasonText}` });
      return;
    }
    // Not all available — open the partial-confirm dialog. User can
    // either accept the reduced checkout or bail entirely.
    if (unavailable.length > 0) {
      setKitPartialConfirm({ collection, available, unavailable, opts: { groupId: groupId ?? null } });
      return;
    }
    // Everything available — execute directly.
    await executeReserveKit(collection, available, { groupId: groupId ?? null });
  }

  // The actual per-item reserve loop. Only runs against the pre-filtered
  // "available" list — either the full membership (all-available fast
  // path) or the subset the user confirmed via the partial dialog.
  async function executeReserveKit(
    collection: Collection,
    itemsToReserve: CollectionItem[],
    opts: { groupId?: string | null },
  ) {
    setReservingKitId(collection.id);
    try {
      const reasons: Record<string, number> = {};
      const addReason = (raw: string) => {
        const k = raw.replace(/\.+$/, "").trim() || "could not reserve";
        reasons[k] = (reasons[k] ?? 0) + 1;
      };
      let reserved = 0;
      for (const i of itemsToReserve) {
        try {
          if (viewAsUserId && showAdminExtras) {
            await apiPost(`/api/super/equipment/${i.equipmentId}/reserve-for`, {
              userId: viewAsUserId,
            });
          } else {
            await apiPost(`/api/equipment/${i.equipmentId}/reserve`, opts.groupId ? { groupId: opts.groupId } : {});
          }
          reserved++;
        } catch (err: any) {
          addReason(err?.message || "could not reserve");
        }
      }

      notifyEquipmentUpdated();
      await load(false);
      apiGet<Collection[]>("/api/equipment-collections").then((list) => setCollections(Array.isArray(list) ? list : []));

      const totalFailed = Object.values(reasons).reduce((a, b) => a + b, 0);
      const reasonEntries = Object.entries(reasons).sort(([, a], [, b]) => b - a);
      const reasonText = reasonEntries.length === 1
        ? reasonEntries[0][0]
        : reasonEntries.map(([msg, n]) => `${msg} (${n})`).join(", ");

      if (totalFailed === 0) {
        publishInlineMessage({ type: "SUCCESS", text: `${collection.name}: ${reserved} reserved` });
      } else if (reserved === 0) {
        publishInlineMessage({ type: "WARNING", text: `${collection.name}: nothing reserved — ${reasonText}` });
      } else {
        publishInlineMessage({ type: "WARNING", text: `${collection.name}: ${reserved} reserved · ${totalFailed} failed — ${reasonText}` });
      }
    } finally {
      setReservingKitId(null);
    }
  }
  async function cancel(e: Equipment) {
    try {
      if (viewAsUserId && showAdminExtras) {
        await apiPost(`/api/super/equipment/${e.id}/reserve-for/cancel`, {
          userId: viewAsUserId,
        });
      } else {
        await apiPost(`/api/equipment/${e.id}/reserve/cancel`);
      }
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' reservation successfully canceled.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          `Equipment '${e.qrSlug}' reservation canceled failed.`,
          err
        ),
      });
    }
  }
  async function forceRelease(e: Equipment) {
    try {
      await apiPost(`/api/admin/equipment/${e.id}/release`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' reservation successfully released.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug}' release failed.`, err),
      });
    }
  }
  async function startMaintainence(e: Equipment) {
    try {
      await apiPost(`/api/admin/equipment/${e.id}/maintenance/start`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' maintenance successfully started.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          `Equipment '${e.qrSlug}' maintenance start failed.`,
          err
        ),
      });
    }
  }
  async function endMaintainence(e: Equipment) {
    try {
      await apiPost(`/api/admin/equipment/${e.id}/maintenance/end`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' maintenance successfully ended.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          `Equipment '${e.qrSlug}' maintenance end failed.`,
          err
        ),
      });
    }
  }
  async function retire(e: Equipment) {
    try {
      await apiPost(`/api/admin/equipment/${e.id}/retire`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' successfully retired.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug}' retire failed.`, err),
      });
    }
  }
  async function unretire(e: Equipment) {
    try {
      await apiPost(`/api/admin/equipment/${e.id}/unretire`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' successfully unretired.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug}' unretired failed.`, err),
      });
    }
  }
  async function hardDelete(id: string, slug: string) {
    try {
      await apiDelete(`/api/admin/equipment/${id}`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${slug}' successfully deleted.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${slug}' delete failed.`, err),
      });
    }
  }

  // ── Super "act on behalf of a worker" handlers ─────────────────────────
  // These hit the /api/super/equipment/* routes which accept a target
  // userId in the body. The audit actor remains the calling Super so the
  // trail records who pulled the lever. checkout-for and return-for skip
  // the QR scan (the Super is the override; the equipment's own qrSlug is
  // sent server-side to satisfy the verify check).
  async function superReserveFor(
    e: Equipment,
    userId: string,
    groupId?: string | null,
  ) {
    try {
      await apiPost(`/api/super/equipment/${e.id}/reserve-for`, {
        userId,
        ...(groupId ? { groupId } : {}),
      });
      notifyEquipmentUpdated();
      await load(false);
      const name = adminWorkerName(userId);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Reserved '${e.qrSlug}' on behalf of ${name}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Reserve on behalf failed.`, err),
      });
    }
  }
  async function superCancelFor(e: Equipment) {
    const uid = e.holder?.userId;
    if (!uid) return;
    try {
      await apiPost(`/api/super/equipment/${e.id}/reserve-for/cancel`, {
        userId: uid,
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Reservation canceled for ${adminWorkerName(uid)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Cancel on behalf failed.`, err),
      });
    }
  }
  async function superCheckoutFor(e: Equipment) {
    const uid = e.holder?.userId;
    if (!uid) return;
    try {
      await apiPost(`/api/super/equipment/${e.id}/checkout-for/verify`, {
        userId: uid,
        slug: e.qrSlug,
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Checked out '${e.qrSlug}' for ${adminWorkerName(uid)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Checkout on behalf failed.`, err),
      });
    }
  }
  async function superReturnFor(e: Equipment) {
    const uid = e.holder?.userId;
    if (!uid) return;
    try {
      await apiPost(`/api/super/equipment/${e.id}/return-for/verify`, {
        userId: uid,
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Returned '${e.qrSlug}' for ${adminWorkerName(uid)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Return on behalf failed.`, err),
      });
    }
  }

  function unavailableMessage(item: Equipment) {
    if (
      item.holder?.state === "CHECKED_OUT" ||
      item.holder?.state === "RESERVED"
    ) {
      let str =
        item.holder.state === "CHECKED_OUT"
          ? "Checked out by "
          : "Reserved by ";
      const holderName = item.holder?.displayName
        || item.holder?.email
        || item.holder?.userId.slice(0, 8);
      // Group rentals display the group name first, claimer in parens —
      // matches the convention used in the equipment-charges listing and
      // makes it obvious at a glance that a whole crew is on the equipment.
      const groupName = (item.holder as any)?.groupName;
      str += groupName ? `${groupName} (${holderName})` : holderName;

      return (
        <Box pt="2">
          <Badge bg={groupName ? "purple.100" : "gray.100"}>{str}</Badge>
        </Box>
      );
    } else {
      return null;
    }
  }

  // ── Action-visibility helpers ───────────────────────────────────────
  // "Worker" actions (like/pin, reserve/cancel/checkout/return) fire on
  // behalf of a subject worker. Without view-as that subject is the
  // caller; with an admin view-as picker active it's the picked worker.
  // The helpers always compare against `subjectUserId` so the same
  // card affordances appear whether admin is looking at themselves or
  // impersonating.
  const subjectUserId = viewAsUserId ?? me?.id ?? null;
  const isTrainee = me?.workerType === "TRAINEE";

  const canWorkerCheckout = (e: Equipment) =>
    showWorkerExtras && e.status === "RESERVED" && !!subjectUserId && e.holder?.userId === subjectUserId;
  const canWorkerCancel = (e: Equipment) =>
    showWorkerExtras && e.status === "RESERVED" && !!subjectUserId && e.holder?.userId === subjectUserId;
  const canWorkerReturn = (e: Equipment) =>
    showWorkerExtras && e.status === "CHECKED_OUT" && !!subjectUserId && e.holder?.userId === subjectUserId;
  const canWorkerReserve = (e: Equipment) =>
    showWorkerExtras &&
    e.status === "AVAILABLE" &&
    // Trainee gate only applies when the ACTING caller is a trainee —
    // an admin viewing-as a trainee is still an admin under the hood
    // and can reserve on their behalf.
    (!!viewAsUserId || !isTrainee);
    // Compliance-policy gating (previously "insurance required") has TWO
    // enforcement layers now:
    //   1. `openReserveConfirm` below does a fast client-side pre-check —
    //      if the equipment lists policies the worker hasn't cleared yet,
    //      dispatch the interceptor event directly so the compliance
    //      dialog opens BEFORE the confirm-reservation dialog. Saves the
    //      worker from accepting terms on a reservation that would then
    //      immediately fail.
    //   2. Server-side `assertPoliciesSigned` in the reserve endpoint —
    //      always runs, catches races (e.g., admin revokes a signature
    //      between our pre-check and the reserve call). The interceptor
    //      picks that up via the same event on the second layer.

  /**
   * Fast pre-flight check that runs when a worker clicks Reserve.
   * If the equipment has any policy requirements the worker hasn't
   * cleared yet (unsigned OR awaiting admin review), dispatch the
   * `policies:required` event so PolicyGateInterceptor opens the correct
   * dialog immediately — bypassing the reserve-confirm step. Returns true
   * when it opened the compliance dialog (caller should NOT open the
   * confirm dialog); false when the reservation should proceed normally.
   *
   * Silent-fail on API errors — the server-side gate will still catch it.
   */
  async function openReserveConfirm(e: Equipment) {
    const equipmentPolicyIds = e.requiredPolicyIds ?? [];
    // Compliance pre-check runs only when the caller is themselves the
    // subject of the reservation. Admin view-as skips this — the
    // super endpoint on the server enforces the picked worker's
    // compliance, and dispatching the interceptor for the admin's
    // own compliance would be nonsensical.
    if (equipmentPolicyIds.length > 0 && showWorkerExtras && !viewAsUserId) {
      try {
        const data = await apiGet<{
          required: Array<{ policyId: string }>;
          awaitingReview?: Array<{ policyId: string }>;
        }>("/api/me/policies");
        const requiredPending = data.required
          .filter((p) => equipmentPolicyIds.includes(p.policyId))
          .map((p) => p.policyId);
        const awaitingPending = (data.awaitingReview ?? [])
          .filter((p) => equipmentPolicyIds.includes(p.policyId))
          .map((p) => p.policyId);
        const pendingIds = [...requiredPending, ...awaitingPending];
        if (pendingIds.length > 0) {
          window.dispatchEvent(
            new CustomEvent("policies:required", {
              detail: { pendingPolicyIds: pendingIds },
            }),
          );
          return; // stop — don't open the reserve confirm dialog
        }
      } catch {
        // Pre-check failed; fall through and let the reserve API surface
        // any compliance issue via the second-layer interceptor.
      }
    }
    setReserveConfirmEquip(e);
    setReserveChecked(false);
  }

  // Super-tier "act on behalf" buttons — hidden when an admin view-as
  // picker is active because the worker-tier buttons (rewired to route
  // through the same super endpoints under view-as) already cover the
  // same intent without the extra picker dialog.
  const showSuperOnBehalfButtons = showSuperExtras && !viewAsUserId;
  const canSuperReserveFor = (e: Equipment) =>
    showSuperOnBehalfButtons && e.status === "AVAILABLE";
  const canSuperCancelFor = (e: Equipment) =>
    showSuperOnBehalfButtons && e.status === "RESERVED" && !!e.holder;
  const canSuperCheckoutFor = (e: Equipment) =>
    showSuperOnBehalfButtons && e.status === "RESERVED" && !!e.holder;
  const canSuperReturnFor = (e: Equipment) =>
    showSuperOnBehalfButtons && e.status === "CHECKED_OUT" && !!e.holder;

  const canAdminForceRelease = (e: Equipment) => showAdminExtras && !!e.holder;
  const canAdminStartMaintenance = (e: Equipment) =>
    showAdminExtras &&
    e.status !== "RETIRED" &&
    e.status !== "MAINTENANCE" &&
    !e.holder;
  const canAdminEndMaintenance = (e: Equipment) =>
    showAdminExtras && e.status === "MAINTENANCE";
  const canAdminRetire = (e: Equipment) =>
    showAdminExtras &&
    e.status !== "RETIRED" &&
    !e.holder &&
    e.status !== "RESERVED" &&
    e.status !== "CHECKED_OUT";
  const canAdminUnretire = (e: Equipment) =>
    showAdminExtras && e.status === "RETIRED";
  // Hard-delete button is super-only, gated on both the UI (this
  // helper) and the server (superGuard on DELETE /admin/equipment/:id).
  // The DeleteDialog previously rendered for admin as shown-but-
  // disabled with a "must be Super" hint, which was confusing —
  // hidden outright is cleaner.
  const canSuperHardDelete = (e: Equipment) =>
    showSuperExtras && e.status === "RETIRED";

  const isMine = (e: Equipment) =>
    !!me && !!e.holder && e.holder.userId === me.id;

  function ItemTile({ item, isMine }: { item: Equipment; isMine?: boolean }) {
    const { open, onToggle } = useDisclosure();

    return (
      <HStack justify="space-between" alignItems="flex-start" w="full">
        {(item.longDesc ||
          item.features ||
          item.condition ||
          item.issues ||
          item.age) && (
          <Box flex="1" w="full">
            <Box mt={1}>
              <Button
                onClick={onToggle}
                size="xs"
                variant="ghost"
                px={1}
                mb={1}
                h="20px"
                fontWeight="semibold"
                color="gray.600"
                aria-expanded={open}
                aria-controls="item-details"
              >
                <HStack gap={1} alignItems="center">
                  <Box as="span">Details</Box>
                  <Box
                    as="span"
                    aria-hidden
                    display="inline-block"
                    transition="transform 0.2s"
                    style={{
                      transform: open ? "rotate(180deg)" : "rotate(0deg)",
                    }}
                  >
                    ▼{/* Or: <ChevronDownIcon /> */}
                  </Box>
                </HStack>
              </Button>

              {open && (
                <Box
                  id="item-details"
                  pl={2}
                  pt={1}
                  // Create vertical rhythm without `spacing` by using row gap
                  display="grid"
                  style={{ rowGap: "0.25rem" }}
                >
                  {item.longDesc && (
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Description:{" "}
                      </Text>
                      {item.longDesc}
                    </Text>
                  )}
                  {item.features && (
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Features:{" "}
                      </Text>
                      {item.features}
                    </Text>
                  )}
                  {item.condition && (
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Condition:{" "}
                      </Text>
                      {item.condition}
                    </Text>
                  )}
                  {item.issues && (
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Issues:{" "}
                      </Text>
                      {item.issues}
                    </Text>
                  )}
                  {item.age && (
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Age:{" "}
                      </Text>
                      {item.age}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </HStack>
    );
  }

  if (!isAvail) return <UnavailableNotice />;
  if (loading && items.length === 0) return <LoadingCenter />;

  return (
    <Box w="full">
      {/* Top toolbar — tab-level actions only (refresh, scan-to-find,
          admin Add). Section-scoped controls (search / compact /
          kind / status / liked / active-filter chips) live inside
          the Equipment section header below since that's the only
          section they affect. */}
      <HStack mt={1} mb={1} gap={2}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            // Reload the equipment list + collections here in the
            // parent, then broadcast so every subsection (Insights,
            // Team/Your Usage, Vehicles insights, etc.) refetches
            // its own data. Listeners hang on the same event name.
            setIsRefreshing(true);
            void load();
            apiGet<Collection[]>("/api/equipment-collections")
              .then((list) => setCollections(Array.isArray(list) ? list : []))
              .catch(() => {});
            try { window.dispatchEvent(new CustomEvent("inventory:refresh")); } catch {}
            // Clear the dim after a fixed window — long enough that
            // fast fetches still register visually, short enough to
            // not feel laggy on slow ones.
            setTimeout(() => setIsRefreshing(false), 900);
          }}
          disabled={isRefreshing}
          px="2"
          flexShrink={0}
          css={{ background: "var(--chakra-colors-gray-100)" }}
          title="Refresh all sections"
        >
          <Box css={isRefreshing ? { animation: "seedlings-spin 0.9s linear infinite" } : undefined}>
            <RefreshCw size={14} />
          </Box>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          px="2"
          flexShrink={0}
          onClick={() => setScanSearchOpen(true)}
          title="Scan a QR code to find equipment"
          css={{ background: "var(--chakra-colors-gray-100)" }}
        >
          <ScanLine size={14} />
        </Button>
        {/* Create Equipment — super-only. Bringing new equipment onto
            the books is a capital-account decision and is gated at
            both the UI (this branch) and the server (superGuard on
            POST /admin/equipment). Admins can still edit + retire
            existing pieces via the card action bands. */}
        {showSuperExtras && (
          <Button
            variant="solid"
            size="sm"
            px="2"
            minW="0"
            onClick={openCreate}
            bg="black"
            color="white"
            title="Add new equipment"
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {/* Refresh-dim wrapper — the isRefreshing flag dims + blocks
          interaction on every section on the tab for a fixed window
          when the toolbar refresh button is clicked. Section-internal
          spinners still fire; this just makes the whole-page reload
          obvious, especially for collapsed sections whose spinners
          wouldn't be visible. */}
      <Box
        css={{
          opacity: isRefreshing ? 0.55 : 1,
          pointerEvents: isRefreshing ? "none" : "auto",
          transition: "opacity 0.15s ease-out",
        }}
      >
      {/* Group-claimer reserve scope picker. Shows whenever the caller
          leads at least one active group (fetched only when the tab
          exposes worker-tier actions). An admin who's also a worker
          and leads a group sees this in admin view too — the
          endpoint returns [] for admin-only users so it's a natural
          no-op there. Hidden when the admin has view-as active,
          since group-scope only applies to the acting worker. */}
      {showWorkerExtras && !viewAsUserId && groupsAsClaimer.length > 0 && (() => {
        const activeGroup = groupsAsClaimer.find((g) => g.id === reserveForGroupId);
        const isUnset = reserveForGroupId == null;
        const isSolo = reserveForGroupId === "";
        const isGroup = !!activeGroup;
        // Unselected state shouts louder than the made-a-choice states so
        // workers don't accidentally hit Reserve without picking a scope.
        const bg = isUnset ? "yellow.50" : isGroup ? "purple.100" : "blue.50";
        const borderColor = isUnset ? "yellow.400" : isGroup ? "purple.400" : "blue.300";
        const headerColor = isUnset ? "yellow.900" : isGroup ? "purple.900" : "blue.900";
        return (
          <Box mb={3} p={3} bg={bg} borderWidth="2px" borderColor={borderColor} borderRadius="md">
            <HStack gap={2} mb={2} align="center">
              {isUnset ? (
                <AlertCircle size={18} color="var(--chakra-colors-yellow-800)" />
              ) : isGroup ? (
                <Users size={18} color="var(--chakra-colors-purple-700)" />
              ) : (
                <User size={18} color="var(--chakra-colors-blue-700)" />
              )}
              <Text fontSize="sm" fontWeight="bold" color={headerColor}>
                {isUnset
                  ? "Pick who you're reserving for"
                  : isGroup
                    ? `Reserving on behalf of ${activeGroup!.name}`
                    : "Reserving for yourself"}
              </Text>
            </HStack>
            <HStack gap={2} wrap="wrap">
              {/* Toggle behavior: tapping the already-selected scope clears
                  the selection (back to unset), so the user can deliberately
                  reset without picking a different one. */}
              <Button
                size="sm"
                variant={isSolo ? "solid" : "outline"}
                colorPalette={isSolo ? "blue" : "gray"}
                onClick={() => setReserveForGroupId(isSolo ? null : "")}
              >
                <User size={14} /> Just me
              </Button>
              {groupsAsClaimer.map((g) => {
                const active = reserveForGroupId === g.id;
                return (
                  <Button
                    key={g.id}
                    size="sm"
                    variant={active ? "solid" : "outline"}
                    colorPalette={active ? "purple" : "gray"}
                    onClick={() => setReserveForGroupId(active ? null : g.id)}
                  >
                    <Users size={14} /> {g.name} ({g.members.length + 1})
                  </Button>
                );
              })}
            </HStack>
            {isGroup && (
              <Text fontSize="xs" color="purple.800" mt={2}>
                Cost will be split among {activeGroup!.members.length + 1} workers on release.
              </Text>
            )}
            {isUnset && (
              <Text fontSize="xs" color="yellow.900" mt={2}>
                You'll be asked to pick when you tap Reserve.
              </Text>
            )}
          </Box>
        );
      })()}
      {/* Super-only Insights — operations-focused rollups only:
          today's fleet state, this-window checkouts + rental income
          + pieces used, the equipment leaderboard, and idle list.
          Team-usage breakdown lives in its own admin+ section below
          so admins have access to it too (Super Insights is now
          reserved for company-operational metrics, not raw per-
          checkout logs). */}
      {showSuperExtras && (
        /* Box carries the top margin — Dashboard styles its own frame and
           takes no layout props. A {JSX comment} here would be a second
           child of this parenthesised expression, which does not parse. */
        <Box mt={3}>
          <Dashboard
            storageKey={`seedlings:${pfx}:insightsOpen`}
            title="Insights"
            icon={BarChart3}
            variant="insights"
          >
            <EquipmentInsightsSection />
          </Dashboard>
        </Box>
      )}
      {/* Admin+ team-usage section — the raw per-checkout log
          from the retired Usage tab, scoped to the whole team.
          Uses UsageBreakdown in SUPER mode (hits the admin
          `/api/admin/equipment-usage` endpoint that returns every
          worker's checkouts) and unlocks the Person group-by. */}
      {showAdminExtras && (
        <Box mt={3} borderWidth="1px" borderColor="gray.300" borderRadius="md" p={3}>
          <HStack
            gap={2}
            align="center"
            mb={teamUsageCollapsed ? 0 : 2}
            cursor="pointer"
            onClick={() => setTeamUsageCollapsed(!teamUsageCollapsed)}
            _hover={{ opacity: 0.7 }}
          >
            <Users size={14} color="var(--chakra-colors-gray-600)" />
            <Text fontSize="sm" fontWeight="bold" color="gray.600" textTransform="uppercase" letterSpacing="wide">
              Team Usage
            </Text>
            <Text fontSize="xs" color="gray.400">{teamUsageCollapsed ? "▶" : "▼"}</Text>
          </HStack>
          {!teamUsageCollapsed && <UsageBreakdown purpose="SUPER" />}
        </Box>
      )}
      {/* Worker-only personal usage — hidden for admin/super since
          they get the fleet-wide Team Usage above (which surfaces
          the caller's own history alongside everyone else's under
          Person group-by). Collapsed by default. */}
      {showWorkerExtras && !showAdminExtras && (
        <Box mt={3} borderWidth="1px" borderColor="gray.300" borderRadius="md" p={3}>
          <HStack
            gap={2}
            align="center"
            mb={usageCollapsed ? 0 : 2}
            cursor="pointer"
            onClick={() => setUsageCollapsed(!usageCollapsed)}
            _hover={{ opacity: 0.7 }}
          >
            <User size={14} color="var(--chakra-colors-gray-600)" />
            <Text fontSize="sm" fontWeight="bold" color="gray.600" textTransform="uppercase" letterSpacing="wide">
              Your Usage
            </Text>
            <Text fontSize="xs" color="gray.400">{usageCollapsed ? "▶" : "▼"}</Text>
          </HStack>
          {!usageCollapsed && <UsageBreakdown purpose="WORKER" />}
        </Box>
      )}
      {collections.length > 0 && (
        <Box mt={3} borderWidth="1px" borderColor="gray.300" borderRadius="md" p={3}>
          <HStack gap={2} align="center" mb={collectionsCollapsed ? 0 : 2}>
            <HStack
              gap={2}
              align="center"
              cursor="pointer"
              onClick={() => setCollectionsCollapsed(!collectionsCollapsed)}
              _hover={{ opacity: 0.7 }}
            >
              <Package size={14} color="var(--chakra-colors-gray-600)" />
              <Text fontSize="sm" fontWeight="bold" color="gray.600" textTransform="uppercase" letterSpacing="wide">Collections</Text>
              <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs">{collections.length}</Badge>
              <Text fontSize="xs" color="gray.400">{collectionsCollapsed ? "▶" : "▼"}</Text>
            </HStack>
            {showAdminExtras && (
              <Badge
                size="sm"
                colorPalette="blue"
                variant="subtle"
                cursor="pointer"
                px="2"
                borderRadius="full"
                onClick={() => {
                  const evName = showSuperExtras ? "navigate:superTab" : "navigate:adminTab";
                  window.dispatchEvent(new CustomEvent(evName, { detail: { tab: "collections" } }));
                }}
              >
                Manage collections →
              </Badge>
            )}
          </HStack>
          {!collectionsCollapsed && (
            <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap={2}>
              {collections.map((c) => {
                const total = c.items.length;
                // Compute availability from live `items` state so releasing,
                // reserving, or retiring a piece is reflected immediately
                // without re-fetching the collections list.
                const available = c.items.filter((i) => {
                  const live = items.find((eq) => eq.id === i.equipmentId);
                  return !!live && !live.retiredAt && live.status === "AVAILABLE";
                }).length;
                const allAvail = total > 0 && available === total;
                const someAvail = available > 0;
                const isExpanded = expandedCollections.has(c.id);
                const equipLabel = (eq: CollectionItem["equipment"]): string => {
                  if (eq.shortDesc) return eq.shortDesc;
                  const parts = [eq.brand, eq.model].filter(Boolean);
                  if (parts.length > 0) return parts.join(" ");
                  if (eq.type) return eq.type;
                  return eq.id.slice(-6);
                };
                return (
                  <Card.Root
                    key={c.id}
                    variant="outline"
                    borderColor={highlightCollectionId === c.id ? "purple.500" : (allAvail ? "green.300" : someAvail ? "yellow.300" : "gray.300")}
                    borderWidth={highlightCollectionId === c.id ? "2px" : "1px"}
                    style={highlightCollectionId === c.id ? { animation: "seedlings-pulse 2.5s ease-in-out infinite" } : undefined}
                  >
                    <Card.Body py="2" px="3">
                      <HStack justify="space-between" align="start" gap={2}>
                        <VStack align="start" gap={0} flex={1} minW={0}>
                          <Text fontSize="sm" fontWeight="semibold">{c.name}</Text>
                          <Text fontSize="xs" color="fg.muted">
                            {available} of {total} available
                          </Text>
                        </VStack>
                        <HStack gap={1.5} flexShrink={0}>
                          <Button
                            size="xs"
                            variant={collectionFilter === c.id ? "solid" : "outline"}
                            colorPalette={collectionFilter === c.id ? "blue" : "gray"}
                            onClick={() =>
                              setCollectionFilter((cur) => (cur === c.id ? null : c.id))
                            }
                          >
                            {collectionFilter === c.id ? "Filtered" : "Filter"}
                          </Button>
                          {isWorkerView && (
                            <Button
                              size="xs"
                              colorPalette={allAvail ? "green" : someAvail ? "yellow" : "gray"}
                              disabled={available === 0}
                              loading={reservingKitId === c.id}
                              onClick={() => void reserveKit(c)}
                            >
                              Reserve{available > 0 && available < total ? ` (${available})` : ""}
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={isExpanded ? "Collapse details" : "Show details"}
                            title={isExpanded ? "Hide details" : "Show description and equipment"}
                            onClick={() => setExpandedCollections((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.id)) next.delete(c.id);
                              else next.add(c.id);
                              return next;
                            })}
                          >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </Button>
                        </HStack>
                      </HStack>
                      {isExpanded && (
                        <VStack align="stretch" gap={1.5} mt={2} pt={2} borderTopWidth="1px" borderColor="gray.200">
                          {c.description ? (
                            <Text fontSize="xs" color="fg.muted">{c.description}</Text>
                          ) : (
                            <Text fontSize="xs" color="fg.muted" fontStyle="italic">No description.</Text>
                          )}
                          {c.items.length > 0 ? (
                            <HStack flexWrap="wrap" gap={1.5}>
                              {c.items.map((it) => {
                                const live = items.find((eq) => eq.id === it.equipmentId);
                                const retired = !!live?.retiredAt || !!it.equipment.retiredAt;
                                const liveStatus = live?.status ?? it.equipment.status;
                                const palette = retired
                                  ? "gray"
                                  : liveStatus === "AVAILABLE"
                                    ? "green"
                                    : liveStatus === "CHECKED_OUT" || liveStatus === "RESERVED"
                                      ? "yellow"
                                      : "gray";
                                return (
                                  <Badge
                                    key={it.id}
                                    size="sm"
                                    colorPalette={palette}
                                    variant="subtle"
                                    cursor="pointer"
                                    title={`Show ${equipLabel(it.equipment)} on this tab`}
                                    onClick={() => {
                                      // Reuse the existing single-item highlight path. Clears any
                                      // active collection filter so the card surfaces.
                                      setCollectionFilter(null);
                                      setHighlightId(it.equipmentId);
                                      setEquipmentCollapsed(false);
                                    }}
                                  >
                                    {equipLabel(it.equipment)}
                                    {retired && " (retired)"}
                                  </Badge>
                                );
                              })}
                            </HStack>
                          ) : (
                            <Text fontSize="xs" color="fg.muted" fontStyle="italic">No equipment in this collection.</Text>
                          )}
                        </VStack>
                      )}
                    </Card.Body>
                  </Card.Root>
                );
              })}
            </SimpleGrid>
          )}
        </Box>
      )}

      <Box position="relative" mt={3} borderWidth="1px" borderColor="gray.300" borderRadius="md" p={3}>
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Box position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)" zIndex="2">
            <Spinner size="lg" />
          </Box>
        </>)}
      <HStack
        gap={2}
        align="center"
        mb={equipmentCollapsed ? 0 : 2}
        cursor="pointer"
        onClick={() => setEquipmentCollapsed(!equipmentCollapsed)}
        _hover={{ opacity: 0.7 }}
      >
        <LayoutGrid size={14} color="var(--chakra-colors-gray-600)" />
        <Text fontSize="sm" fontWeight="bold" color="gray.600" textTransform="uppercase" letterSpacing="wide">Equipment</Text>
        <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs">{filtered.length}</Badge>
        <Text fontSize="xs" color="gray.400">{equipmentCollapsed ? "▶" : "▼"}</Text>
      </HStack>
      {!equipmentCollapsed && (
      <VStack align="stretch" gap={3}>
        {/* Admin view-as picker — scopes ONLY the Equipment section
            (card actions + kit reserve). Insights / Team Usage /
            Collections list are fleet-wide regardless. Lives here
            inside the Equipment frame so it's obvious what it
            affects, not up at the tab level. */}
        {showAdminExtras && (
          <HStack gap={2} wrap="wrap" alignItems="center">
            <AdminViewAsSelector
              workers={adminWorkers as AdminWorker[]}
              selected={viewAsUserIds}
              // AdminViewAsSelector is multi-select — clicking a new
              // worker APPENDS to the array. Inventory only supports
              // one impersonation target at a time, so keep the
              // LAST clicked worker (slice(-1)), not the first —
              // otherwise re-opening the dropdown and picking a
              // different worker silently keeps the old one.
              onChange={(next) => setViewAsUserIds(next.slice(-1))}
            />
          </HStack>
        )}
        {showAdminExtras && viewAsUserIds.length > 0 && (
          <HStack gap={1} wrap="wrap" pl="1" alignItems="center">
            <Text fontSize="xs" color="fg.muted">Acting as:</Text>
            <AdminViewAsBadges workers={adminWorkers as AdminWorker[]} selected={viewAsUserIds} />
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => setViewAsUserIds([])}
            >
              ✕ Clear
            </Badge>
          </HStack>
        )}
        {/* Filter toolbar — search / kind / status / liked / density
            toggle. These scope the Equipment cards below and nothing
            else on the tab, so they live inside this section frame. */}
        <HStack gap={2}>
          <SearchWithClear
            ref={inputRef}
            value={q}
            onChange={setQ}
            inputId="equipment-search"
            placeholder="Search…"
          />
          <Button
            size="sm"
            variant="ghost"
            px="2"
            flexShrink={0}
            onClick={() => { setCompact((v) => !v); setExpandedCards(new Set()); }}
            css={{
              background: !compact ? "var(--chakra-colors-gray-200)" : "var(--chakra-colors-gray-100)",
              color: !compact ? "var(--chakra-colors-gray-700)" : undefined,
            }}
            title={compact ? "Expand all cards" : "Collapse all cards"}
          >
            <Maximize2 size={14} />
          </Button>
          <Select.Root
            collection={kindCollection}
            value={kind}
            onValueChange={(e) => setKind(e.value)}
            size="sm"
            positioning={{ strategy: "fixed", hideWhenDetached: true }}
            css={{ width: "auto", flex: "0 0 auto" }}
          >
            <Select.Control>
              <Select.Trigger w="auto" minW="0" px="2" css={{ background: kind[0] !== "ALL" ? "var(--chakra-colors-blue-200)" : "var(--chakra-colors-blue-100)", border: kind[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-400)" : "1px solid var(--chakra-colors-blue-300)", borderRadius: "6px" }}>
                <LayoutList size={14} />
                <Select.Indicator display="none" />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {kindItems.map((it) => (
                  <Select.Item key={it.value} item={it.value}>
                    <Select.ItemText>{it.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select.Root>
          <Select.Root
            collection={statusCollection}
            value={statusFilter}
            onValueChange={(e) => setStatusFilter(e.value)}
            size="sm"
            positioning={{ strategy: "fixed", hideWhenDetached: true }}
            css={{ width: "auto", flex: "0 0 auto" }}
          >
            <Select.Control>
              <Select.Trigger w="auto" minW="0" px="2" css={{ background: statusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-200)" : "var(--chakra-colors-purple-100)", border: statusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-400)" : "1px solid var(--chakra-colors-purple-300)", borderRadius: "6px" }}>
                <Filter size={14} />
                <Select.Indicator display="none" />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {statusItems.map((it) => (
                  <Select.Item key={it.value} item={it.value}>
                    <Select.ItemText>{it.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select.Root>
          {isWorkerView && (
            <Button
              size="sm"
              variant={likedOnly ? "solid" : "outline"}
              px="2"
              flexShrink={0}
              onClick={() => setLikedOnly(!likedOnly)}
              css={likedOnly ? {
                background: "var(--chakra-colors-red-100)",
                color: "var(--chakra-colors-red-600)",
                border: "1px solid var(--chakra-colors-red-400)",
                "&:hover": { background: "var(--chakra-colors-red-200)" },
              } : undefined}
              title="Show liked only"
            >
              <Heart size={14} fill={likedOnly ? "currentColor" : "none"} color="var(--chakra-colors-red-500)" />
            </Button>
          )}
        </HStack>
        {/* Active-filter chip row — reflects the toolbar's current
            state and offers a ✕ Clear to reset all filters at once. */}
        {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || (isWorkerView && likedOnly) || (forAdmin && workerFilter.length > 0) || !!collectionFilter || highlightId) && (
          <HStack gap={1} wrap="wrap" pl="2">
            {collectionFilter && (() => {
              const c = collections.find((x) => x.id === collectionFilter);
              return (
                <Badge size="sm" colorPalette="blue" variant="solid" cursor="pointer" onClick={() => setCollectionFilter(null)}>
                  Collection: {c?.name ?? collectionFilter} ✕
                </Badge>
              );
            })()}
            {highlightId && (
              <Badge size="sm" colorPalette="teal" variant="subtle">Filtered to 1 item</Badge>
            )}
            {!highlightId && kind[0] !== "ALL" && (
              <Badge size="sm" colorPalette="blue" variant="subtle">
                {kindItems.find((i) => i.value === kind[0])?.label}
              </Badge>
            )}
            {!highlightId && statusFilter[0] !== "ALL" && (
              <Badge size="sm" colorPalette="purple" variant="subtle">
                {statusItems.find((i) => i.value === statusFilter[0])?.label}
              </Badge>
            )}
            {!highlightId && isWorkerView && likedOnly && (
              <Badge size="sm" colorPalette="red" variant="subtle">Liked</Badge>
            )}
            {!highlightId && forAdmin && workerFilter.map((id) => (
              <Badge key={id} size="sm" colorPalette="blue" variant="solid">
                {adminWorkerName(id)}
              </Badge>
            ))}
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setHighlightId(null);
                setKind(["ALL"]);
                setStatusFilter(["ALL"]);
                setCollectionFilter(null);
                if (isWorkerView) setLikedOnly(false);
                if (forAdmin) setWorkerFilter([]);
              }}
            >
              ✕ Clear
            </Badge>
          </HStack>
        )}
        {filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No equipment matches current filters.
          </Box>
        )}
        {groups.map((group) => (
          <Box key={group.key} data-group={group.key}>
            {group.label && (
              <HStack
                gap={3}
                align="center"
                my={2}
                cursor="pointer"
                onClick={() => setCollapsedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })}
                _hover={{ opacity: 0.7 }}
              >
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
                <HStack gap={1.5} align="center">
                  <Text fontSize="sm" fontWeight="bold" color="gray.600" whiteSpace="nowrap" textTransform="uppercase" letterSpacing="wide">
                    {group.label}
                  </Text>
                  <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs" lineHeight="1">
                    {group.items.length}
                  </Badge>
                  <Text fontSize="xs" color="gray.400">{collapsedGroups.has(group.key) ? "▶" : "▼"}</Text>
                </HStack>
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
              </HStack>
            )}
            {!collapsedGroups.has(group.key) && <VStack align="stretch" gap={3}>
            {group.items.map((e: Equipment) => {
          const isCardCompact = compact && !expandedCards.has(e.id);
          const toggleCard = compact
            ? () => setExpandedCards((prev) => {
                const next = new Set(prev);
                if (next.has(e.id)) next.delete(e.id);
                else next.add(e.id);
                return next;
              })
            : undefined;

          return (
          <Card.Root
            key={e.id}
            variant="outline"
            css={compact ? { cursor: "pointer", "& a, & button": { pointerEvents: "auto" } } : undefined}
            onClick={(ev: any) => {
              if (!toggleCard) return;
              const el = ev.target as HTMLElement;
              if (el?.closest?.("a, button")) return;
              toggleCard();
            }}
          >
            {/* Equipment instructions — surfaced at the TOP of the
                card (before header/body/footer) so critical notes
                are the first thing the worker reads, not something
                buried under status chips + action buttons. Same
                rendering shape for compact and expanded densities;
                only the margins differ. */}
            {(e.instructions ?? []).length > 0 && (
              isCardCompact ? (
                <Box mx="3" mt="2" mb="0" display="flex" flexWrap="wrap" gap="1">
                  {(e.instructions ?? []).map((inst) => (
                    <HStack key={inst.id} gap="1.5" px="2" py="1" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                      <AlertCircle
                        size={18}
                        color="var(--chakra-colors-yellow-900)"
                        fill="var(--chakra-colors-yellow-400)"
                        strokeWidth={2.5}
                      />
                      <Text fontSize="xs" fontWeight="semibold" color="yellow.700">{inst.text}</Text>
                    </HStack>
                  ))}
                </Box>
              ) : (
                <Box mx="3" mt="2" mb="0" px="3" py="1.5" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                  <VStack align="stretch" gap="0.5">
                    {(e.instructions ?? []).map((inst) => (
                      <HStack key={inst.id} gap="1.5" align="center">
                        <AlertCircle
                          size={18}
                          color="var(--chakra-colors-yellow-900)"
                          fill="var(--chakra-colors-yellow-400)"
                          strokeWidth={2.5}
                        />
                        <Text fontSize="xs" fontWeight="semibold" color="yellow.700">
                          {inst.text}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
                </Box>
              )
            )}
            {isCardCompact ? (
              <HStack align="center" gap={3} py="2" px="3">
                <EquipmentThumbnail equipmentId={e.id} hasPhotos={e.hasPhotos} />
                <VStack align="stretch" gap={1} flex="1" minW={0}>
                  <HStack justify="space-between" alignItems="flex-start" gap={2}>
                  <Box display="flex" flexDirection="column" gap={1} flex="1" minW={0}>
                    <HStack gap={2} alignItems="center" minW={0}>
                      {(() => {
                        if (canWorkerReserve(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="green.400" color="green.900" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "green.500" }} title="Reserve" onClick={(ev: any) => {
                              ev.stopPropagation();
                              void openReserveConfirm(e);
                            }}><Hand size={12} /></Box>
                          );
                        }
                        if (canWorkerCheckout(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="blue.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "blue.600" }} title="Check Out" onClick={(ev: any) => {
                              ev.stopPropagation();
                              setScanFor(e.id);
                            }}><ScanLine size={12} /></Box>
                          );
                        }
                        if (canWorkerReturn(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="orange.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "orange.600" }} title="Return" onClick={(ev: any) => {
                              ev.stopPropagation();
                              setReturnConfirmEquip(e);
                            }}><RotateCcw size={12} /></Box>
                          );
                        }
                        return null;
                      })()}
                      <Text
                        fontSize="sm"
                        fontWeight="semibold"
                        whiteSpace="nowrap"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        minW={0}
                        flex="1"
                        title={e.shortDesc}
                      >{e.shortDesc}</Text>
                    </HStack>
                    <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" flexShrink={0} mb={1}>
                      <StatusBadge
                        status={e.status ?? ""}
                        palette={equipmentStatusColor(e.status ?? "")}
                        variant="subtle"
                      />
                      <StatusBadge status={e.type} palette="gray" variant="outline" />
                      {(e.requiredPolicyIds?.length ?? 0) > 0 && (
                        <Box as="span" display="inline-flex" alignItems="center" title={`${e.requiredPolicyIds!.length} compliance polic${e.requiredPolicyIds!.length === 1 ? "y" : "ies"} required to reserve this equipment`}>
                          <StatusBadge status="Policy req" palette="yellow" variant="subtle" />
                        </Box>
                      )}
                    </Box>
                  </Box>
                  <ActionIcons equipmentId={e.id} />
                  </HStack>
                  <HStack gap={2} fontSize="xs" color="fg.muted" wrap="wrap">
                    <Text>
                      {e.brand ? `${e.brand} ` : ""}
                      {e.model ? `${e.model} ` : ""}
                    </Text>
                    {(() => {
                      // Compact-card billing pill — same additive rules as
                      // the full card: caller's own rate for worker
                      // scope, plus the equipment's contractor rate chip
                      // for admin scope. Space is tight here so we skip
                      // the role labels — the color palettes carry the
                      // distinction (orange = admin/contractor rate,
                      // blue/green = personal rate).
                      const chip = shortBillingChip(resolveBillingMode(e.dailyRate, e.equivalentJobs, equipmentBillingEnabled));
                      const wt = me?.workerType;
                      const palette = wt === "EMPLOYEE" ? "blue" : wt === "TRAINEE" ? "green" : "orange";
                      const rate = wt === "CONTRACTOR" ? e.dailyRate : null;
                      const workerPill = showWorkerExtras
                        ? rate != null && rate > 0
                          ? <Badge key="w" colorPalette={palette} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">${rate.toFixed(2)}/day</Badge>
                          : <Badge key="w" colorPalette={palette} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                        : null;
                      const adminPill = showAdminExtras && chip
                        ? <Badge key="a" colorPalette="orange" variant="subtle" fontSize="xs" px="1.5" borderRadius="full" title="Contractor billing">{chip}</Badge>
                        : null;
                      return <>{workerPill}{adminPill}</>;
                    })()}
                  </HStack>
                </VStack>
              </HStack>
            ) : (
            <>
            <Card.Header py="2" px="3" pb="0">
              <HStack justify="space-between" alignItems="flex-start" gap={2}>
              <Box display="flex" flexDirection="column" gap={1} flex="1" minW={0}>
                <Text fontSize="md" fontWeight="semibold">{e.shortDesc}</Text>
                <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" flexShrink={0} mb={1}>
                  <StatusBadge
                    status={e.status ?? ""}
                    palette={equipmentStatusColor(e.status ?? "")}
                    variant="subtle"
                  />
                  <StatusBadge status={e.type} palette="gray" variant="outline" />
                  {(e.requiredPolicyIds?.length ?? 0) > 0 && (
                    <Box as="span" display="inline-flex" alignItems="center" title={`${e.requiredPolicyIds!.length} compliance polic${e.requiredPolicyIds!.length === 1 ? "y" : "ies"} required to reserve this equipment`}>
                      <StatusBadge status="Policy req" palette="yellow" variant="subtle" />
                    </Box>
                  )}
                </Box>
              </Box>
              <ActionIcons equipmentId={e.id} />
              </HStack>
            </Card.Header>
            <Card.Body py="2" px="3" pt="0">
              <VStack align="start" gap={0}>
                <Text fontSize="sm" color="fg.muted">
                  {e.brand ? `${e.brand} ` : ""}
                  {e.model ? `${e.model} ` : ""}
                </Text>
                <Box mt={1} mb={1}>
                  <EquipmentPhotos equipmentId={e.id} readOnly={!forAdmin} hasPhotos={e.hasPhotos} />
                </Box>
                {e.qrSlug && (
                  <HStack gap={1} mt={0} align="center">
                    <Text fontSize="xs" color="gray.500">
                      <Text as="span" fontWeight="bold">
                        ID:{" "}
                      </Text>
                      {e.qrSlug}
                    </Text>
                    <Box
                      as="button"
                      flexShrink={0}
                      color="gray.400"
                      _hover={{ color: "blue.600" }}
                      title="Copy ID"
                      onClick={(ev: any) => {
                        ev.stopPropagation();
                        navigator.clipboard?.writeText(e.qrSlug!).then(
                          () => publishInlineMessage({ type: "SUCCESS", text: `Copied "${e.qrSlug}"` }),
                          () => publishInlineMessage({ type: "ERROR", text: "Copy failed." }),
                        );
                      }}
                    >
                      <Copy size={11} />
                    </Box>
                  </HStack>
                )}
                {e.energy && (
                  <Text fontSize="xs" color="gray.500" mt={0}>
                    <Text as="span" fontWeight="bold">
                      Power:{" "}
                    </Text>
                    {e.energy}
                  </Text>
                )}
                {(() => {
                  // Billing display — capabilities ADD by scope:
                  //  • Worker row (always when scope includes worker) —
                  //    shows THIS operator's own rate: contractor sees
                  //    the daily rate, employee/trainee sees "No charge".
                  //  • Admin row (when scope includes admin) — shows
                  //    the CONTRACTOR + EMPLOYEE billing rules for the
                  //    equipment itself, so admins can audit the
                  //    rate/cap config at a glance.
                  //
                  // Each row is prefixed with a small role label so a
                  // super sees both without confusion. The role label
                  // pattern mirrors the ElevatedActionRow footer bands.
                  const mode = resolveBillingMode(e.dailyRate, e.equivalentJobs, equipmentBillingEnabled);
                  const chip = shortBillingChip(mode);
                  const wt = me?.workerType;
                  const workerRateBadge = (() => {
                    if (wt === "TRAINEE") return (
                      <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        No charge — trainees cannot reserve
                      </Badge>
                    );
                    if (wt === "EMPLOYEE") return (
                      <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">No charge</Badge>
                    );
                    // CONTRACTOR (or unknown workerType — treat as chargeable)
                    return chip ? (
                      <>
                        <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="2" borderRadius="full">{chip}</Badge>
                        <Text fontSize="xs" color="orange.500">rental cost</Text>
                      </>
                    ) : (
                      <Text fontSize="xs" color="orange.500">No rental cost</Text>
                    );
                  })();
                  return (
                    <VStack align="start" gap={1} mt={0.5} fontSize="xs">
                      {showWorkerExtras && (
                        <HStack gap={2}>
                          <Badge size="xs" variant="subtle" colorPalette="blue">You</Badge>
                          {workerRateBadge}
                        </HStack>
                      )}
                      {showAdminExtras && (
                        <>
                          <HStack gap={2}>
                            <Badge size="xs" variant="subtle" colorPalette="purple">Admin</Badge>
                            <Text color="fg.muted">Contractor:</Text>
                            {chip ? (
                              <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">{chip}</Badge>
                            ) : (
                              <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                            )}
                          </HStack>
                          <HStack gap={2}>
                            <Badge size="xs" variant="subtle" colorPalette="purple">Admin</Badge>
                            <Text color="fg.muted">Employee:</Text>
                            <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                          </HStack>
                        </>
                      )}
                    </VStack>
                  );
                })()}
                {/* Minimal collapsible for details */}
                <ItemTile item={e} isMine={isMine(e)} />
                {unavailableMessage(e)}
              </VStack>
            </Card.Body>
            <Card.Footer py="0" px="0" pt="0" flexDirection="column" alignItems="stretch" gap={0}>
              <CardActionBands
                e={e}
                loading={loading}
                statusButtonBusyId={statusButtonBusyId}
                setStatusButtonBusyId={setStatusButtonBusyId}
                // Gates
                showWorkerExtras={showWorkerExtras}
                showAdminExtras={showAdminExtras}
                isTrainee={isTrainee}
                viewAsUserId={viewAsUserId}
                viewAsUserName={viewAsUserId ? adminWorkerName(viewAsUserId) : null}
                canWorkerCheckout={canWorkerCheckout(e)}
                canWorkerCancel={canWorkerCancel(e)}
                canWorkerReturn={canWorkerReturn(e)}
                canWorkerReserve={canWorkerReserve(e)}
                canAdminForceRelease={canAdminForceRelease(e)}
                canAdminStartMaintenance={canAdminStartMaintenance(e)}
                canAdminEndMaintenance={canAdminEndMaintenance(e)}
                canAdminRetire={canAdminRetire(e)}
                canAdminUnretire={canAdminUnretire(e)}
                canSuperHardDelete={canSuperHardDelete(e)}
                canSuperReserveFor={canSuperReserveFor(e)}
                canSuperCancelFor={canSuperCancelFor(e)}
                canSuperCheckoutFor={canSuperCheckoutFor(e)}
                canSuperReturnFor={canSuperReturnFor(e)}
                // Handlers
                onEdit={() => void openEdit(e)}
                onWorkerCheckout={() => void setScanFor(e.id)}
                onWorkerCancel={() => void cancel(e)}
                onWorkerReturn={() => void setReturnConfirmEquip(e)}
                onWorkerReserve={() => void openReserveConfirm(e)}
                onForceRelease={() => void forceRelease(e)}
                onStartMaintenance={() => void startMaintainence(e)}
                onEndMaintenance={() => void endMaintainence(e)}
                onRetire={() => void retire(e)}
                onUnretire={() => void unretire(e)}
                onHardDelete={() =>
                  void setToDelete({
                    id: e.id,
                    title: "Delete equipment?",
                    summary: e.shortDesc,
                    extra: e.qrSlug,
                  })
                }
                onSuperReserveFor={() => {
                  setSuperPickerUserId("");
                  setSuperActionFor({ equipment: e, action: "reserve" });
                }}
                onSuperCancelFor={() => setSuperActionFor({ equipment: e, action: "cancel" })}
                onSuperCheckoutFor={() => setSuperActionFor({ equipment: e, action: "checkout" })}
                onSuperReturnFor={() => setSuperActionFor({ equipment: e, action: "return" })}
              />
            </Card.Footer>
            </>
            )}
          </Card.Root>
          );
        })}
            </VStack>}
          </Box>
        ))}
      </VStack>
      )}
      </Box>

      <QRScannerDialog
        open={!!scanFor}
        label="Scan QR Code to Check Out"
        onClose={() => void setScanFor(null)}
        onDetected={async (slug) => {
          const id = scanFor!;
          setStatusButtonBusyId(`equipment-checkout${id}`);
          setScanFor(null);
          await checkoutVerifiedWithSlug(id, slug);
          setStatusButtonBusyId("");
        }}
      />
      <QRScannerDialog
        open={scanSearchOpen}
        label="Scan QR Code to Find Equipment"
        onClose={() => setScanSearchOpen(false)}
        onDetected={(slug) => {
          setQ(extractSlug(slug));
          setScanSearchOpen(false);
        }}
      />
      <ConfirmDialog
        open={!!returnConfirmEquip}
        title="Return this equipment?"
        message={
          returnConfirmEquip
            ? `Check in "${returnConfirmEquip.shortDesc || `${returnConfirmEquip.brand ?? ""} ${returnConfirmEquip.model ?? ""}`.trim() || returnConfirmEquip.qrSlug}" and make it available again.`
            : ""
        }
        confirmLabel="Return"
        confirmColorPalette="orange"
        onConfirm={async () => {
          const e = returnConfirmEquip;
          setReturnConfirmEquip(null);
          if (e) await doReturn(e);
        }}
        onCancel={() => setReturnConfirmEquip(null)}
      />
      {/* Partial-availability confirm for kit reservations. Fires
          when the caller taps Reserve on a collection that has some
          — but not all — members available. Lists what will be
          reserved + what's excluded (with the blocking reason for
          each), and asks whether to proceed with the reduced set. */}
      <ConfirmDialog
        open={!!kitPartialConfirm}
        title={kitPartialConfirm ? `Some ${kitPartialConfirm.collection.name} items aren't available` : ""}
        message=""
        messageNode={kitPartialConfirm ? (
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm">
              Reserve the {kitPartialConfirm.available.length} available piece{kitPartialConfirm.available.length === 1 ? "" : "s"}
              {" "}and skip the {kitPartialConfirm.unavailable.length} that {kitPartialConfirm.unavailable.length === 1 ? "isn't" : "aren't"} ready?
            </Text>
            <Box borderWidth="1px" borderColor="green.300" borderRadius="md" bg="green.50" px={2} py={1.5}>
              <Text fontSize="xs" color="green.800" fontWeight="semibold" mb={1}>
                Will reserve ({kitPartialConfirm.available.length})
              </Text>
              <VStack align="stretch" gap={0.5}>
                {kitPartialConfirm.available.map((it) => (
                  <Text key={it.id} fontSize="xs" color="green.900">
                    • {it.equipment.shortDesc
                        || [it.equipment.brand, it.equipment.model].filter(Boolean).join(" ")
                        || it.equipment.type
                        || it.equipmentId.slice(-6)}
                  </Text>
                ))}
              </VStack>
            </Box>
            <Box borderWidth="1px" borderColor="yellow.300" borderRadius="md" bg="yellow.50" px={2} py={1.5}>
              <Text fontSize="xs" color="yellow.900" fontWeight="semibold" mb={1}>
                Will skip ({kitPartialConfirm.unavailable.length})
              </Text>
              <VStack align="stretch" gap={0.5}>
                {kitPartialConfirm.unavailable.map((u) => (
                  <HStack key={u.item.id} gap={2} justify="space-between">
                    <Text fontSize="xs" color="yellow.900">
                      • {u.item.equipment.shortDesc
                          || [u.item.equipment.brand, u.item.equipment.model].filter(Boolean).join(" ")
                          || u.item.equipment.type
                          || u.item.equipmentId.slice(-6)}
                    </Text>
                    <Badge size="xs" colorPalette="yellow" variant="subtle">{u.reason}</Badge>
                  </HStack>
                ))}
              </VStack>
            </Box>
          </VStack>
        ) : undefined}
        confirmLabel={kitPartialConfirm ? `Reserve ${kitPartialConfirm.available.length} of ${kitPartialConfirm.available.length + kitPartialConfirm.unavailable.length}` : "Reserve"}
        confirmColorPalette="green"
        onConfirm={async () => {
          const p = kitPartialConfirm;
          setKitPartialConfirm(null);
          if (p) await executeReserveKit(p.collection, p.available, p.opts);
        }}
        onCancel={() => setKitPartialConfirm(null)}
      />
      {showAdminExtras && (
        <EquipmentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          role="ADMIN"
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {showAdminExtras && (
        <DeleteDialog
          toDelete={toDelete}
          cancel={() => setToDelete(null)}
          complete={async () => {
            if (!toDelete) return;
            await hardDelete(toDelete.id, toDelete.extra ?? "");
            setToDelete(null);
          }}
        />
      )}

      {/* Scope-pick prompt: opens when a claimer-of-group(s) hits Reserve
          without first choosing "Just me" or "[Group]". Closing the dialog
          via a button records the choice and replays the original reserve. */}
      <Dialog.Root open={!!reserveScopePromptFor} onOpenChange={(e) => { if (!e.open) setReserveScopePromptFor(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>
                  {reserveForGroupId == null
                    ? "Who are you reserving for?"
                    : "Confirm reservation"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={2}>
                  <Text fontSize="sm" color="fg.muted">
                    {reserveForGroupId == null
                      ? "You lead one or more groups. Pick whether this reservation is for yourself or on behalf of a group — group rentals split the cost among group workers when the equipment is released."
                      : "Confirm the scope below, or tap a different option to switch."}
                  </Text>
                  <Button
                    size="sm"
                    variant={reserveForGroupId === "" ? "solid" : "outline"}
                    colorPalette="blue"
                    onClick={() => {
                      const target = reserveScopePromptFor;
                      setReserveForGroupId("");
                      setReserveScopePromptFor(null);
                      if (target?.kind === "single") void doReserve(target.equipment, { groupId: "" });
                      else if (target?.kind === "collection") void doReserveKit(target.collection, { groupId: "" });
                    }}
                  >
                    <User size={14} /> Just me{reserveForGroupId === "" ? " — confirm" : ""}
                  </Button>
                  {groupsAsClaimer.map((g) => {
                    const active = reserveForGroupId === g.id;
                    return (
                      <Button
                        key={g.id}
                        size="sm"
                        variant={active ? "solid" : "outline"}
                        colorPalette="purple"
                        onClick={() => {
                          const target = reserveScopePromptFor;
                          setReserveForGroupId(g.id);
                          setReserveScopePromptFor(null);
                          if (target?.kind === "single") void doReserve(target.equipment, { groupId: g.id });
                          else if (target?.kind === "collection") void doReserveKit(target.collection, { groupId: g.id });
                        }}
                      >
                        <Users size={14} /> For {g.name} ({g.members.length + 1}){active ? " — confirm" : ""}
                      </Button>
                    );
                  })}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="center" w="full">
                  <Button variant="outline" onClick={() => setReserveScopePromptFor(null)}>
                    Cancel
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Reserve Confirmation Dialog */}
      <Dialog.Root open={!!reserveConfirmEquip} onOpenChange={(e) => { if (!e.open) { setReserveConfirmEquip(null); setReserveChecked(false); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Reserve Equipment</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {reserveConfirmEquip && (
                  <VStack align="stretch" gap={3}>
                    <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                      <Text fontSize="sm" fontWeight="medium">{reserveConfirmEquip.shortDesc}</Text>
                      {(reserveConfirmEquip.brand || reserveConfirmEquip.model) && (
                        <Text fontSize="xs" color="fg.muted">
                          {[reserveConfirmEquip.brand, reserveConfirmEquip.model].filter(Boolean).join(" ")}
                        </Text>
                      )}
                      {(() => {
                        const wt = me?.workerType;
                        // Only contractors are charged. Employees + trainees
                        // see a green "no charge" message. Billing mode +
                        // copy come from the shared helper so this matches
                        // every other equipment surface.
                        const mode = resolveBillingMode(
                          reserveConfirmEquip.dailyRate,
                          reserveConfirmEquip.equivalentJobs,
                          equipmentBillingEnabled,
                        );
                        const isContractor = wt === "CONTRACTOR" || !wt;
                        if (mode.kind !== "free" && isContractor) {
                          return (
                            <Box mt={1} p={2} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.300">
                              <Text fontSize="sm" color="orange.800" fontWeight="semibold">
                                Rental charge: {shortBillingChip(mode)}
                              </Text>
                              <Text fontSize="xs" color="orange.700" mt={0.5}>
                                {instructiveBillingText(mode)}
                              </Text>
                            </Box>
                          );
                        }
                        return (
                          <Box mt={1} p={2} bg="green.50" rounded="md">
                            <Text fontSize="xs" color="green.700" fontWeight="medium">
                              {wt === "EMPLOYEE" ? "No charge  — equipment covered for employees"
                                : wt === "TRAINEE" ? "No charge  — equipment covered for employees"
                                : "No rental charge for this equipment"}
                            </Text>
                          </Box>
                        );
                      })()}
                    </Box>

                    <Text fontSize="sm">
                      By reserving this equipment, you accept responsibility for its care and safe use.
                      You agree to return it in the same condition and report any damage or issues immediately.
                      You assume all liability for any injury, damage, or loss arising from the use of this equipment.
                    </Text>

                    {/* Per-mode pricing recap moved into the orange chip
                        above (which now reads from `instructiveBillingText`),
                        so the duplicate blue panel that always said
                        "rental rate $X/day" is dropped. The chip handles
                        both flat-daily and per-job-with-cap modes. */}

                    <Checkbox.Root
                      checked={reserveChecked}
                      onCheckedChange={(e) => setReserveChecked(!!e.checked)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label fontSize="sm">
                        I accept responsibility for this equipment and agree to the terms above
                      </Checkbox.Label>
                    </Checkbox.Root>
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setReserveConfirmEquip(null)}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette="green"
                    disabled={!reserveChecked}
                    onClick={async () => {
                      if (reserveConfirmEquip) {
                        await reserve(reserveConfirmEquip);
                        setReserveConfirmEquip(null);
                        setReserveChecked(false);
                      }
                    }}
                  >
                    Reserve Equipment
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Super "act on behalf of a worker" dialog. Reserve picks a worker
          from the workers list; the other three actions imply the current
          holder. checkout-for and return-for skip the QR scan since the
          Super is the override path. */}
      <Dialog.Root
        open={!!superActionFor}
        onOpenChange={(e) => {
          if (!e.open) {
            setSuperActionFor(null);
            setSuperPickerUserId("");
          }
        }}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>
                  {superActionFor?.action === "reserve" && "Reserve on behalf of a worker"}
                  {superActionFor?.action === "cancel" && "Cancel reservation on behalf"}
                  {superActionFor?.action === "checkout" && "Check out on behalf"}
                  {superActionFor?.action === "return" && "Return on behalf"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {/* Surface the impersonation warning once a worker is
                    selected — every action in this dialog ("on behalf
                    of") is a Super acting on someone else's equipment
                    record. Until they pick, no warning (action is not
                    yet associated with anyone). The role-impersonation
                    side of the banner still fires when applicable. */}
                <ImpersonationWarning
                  viewAsName={
                    superPickerUserId
                      ? (adminWorkers.find((w) => w.id === superPickerUserId)?.displayName
                          ?? adminWorkers.find((w) => w.id === superPickerUserId)?.email
                          ?? null)
                      : null
                  }
                />
                {superActionFor && (
                  <VStack align="stretch" gap={3}>
                    <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                      <Text fontSize="sm" fontWeight="medium">
                        {superActionFor.equipment.shortDesc}
                      </Text>
                      {(superActionFor.equipment.brand || superActionFor.equipment.model) && (
                        <Text fontSize="xs" color="fg.muted">
                          {[superActionFor.equipment.brand, superActionFor.equipment.model]
                            .filter(Boolean)
                            .join(" ")}
                        </Text>
                      )}
                      <Text fontSize="xs" color="fg.muted" mt={1}>
                        QR: {superActionFor.equipment.qrSlug}
                      </Text>
                    </Box>

                    {superActionFor.action === "reserve" ? (
                      <>
                        <Text fontSize="sm" color="fg.muted">
                          Pick the worker this reservation should be recorded for. The audit trail will show you as the Super who performed the action.
                        </Text>
                        <Box>
                          <Text fontSize="xs" fontWeight="semibold" mb={1}>Worker</Text>
                          <Select.Root
                            collection={superWorkerCollection}
                            value={superPickerUserId ? [superPickerUserId] : []}
                            onValueChange={(e) => setSuperPickerUserId(e.value[0] ?? "")}
                            size="sm"
                            positioning={{ strategy: "fixed", hideWhenDetached: true }}
                          >
                            <Select.Control>
                              <Select.Trigger w="full">
                                <Select.ValueText placeholder="— select worker —" />
                              </Select.Trigger>
                            </Select.Control>
                            <Select.Positioner>
                              <Select.Content>
                                {superWorkerItems.map((it) => (
                                  <Select.Item key={it.value} item={it.value}>
                                    <Select.ItemText>{it.label}</Select.ItemText>
                                  </Select.Item>
                                ))}
                              </Select.Content>
                            </Select.Positioner>
                          </Select.Root>
                        </Box>
                      </>
                    ) : (
                      <Box p={2} bg="purple.50" rounded="md" borderWidth="1px" borderColor="purple.200">
                        <Text fontSize="sm" color="purple.800">
                          {superActionFor.action === "cancel" && "Cancel "}
                          {superActionFor.action === "checkout" && "Check out "}
                          {superActionFor.action === "return" && "Return "}
                          on behalf of{" "}
                          <Text as="span" fontWeight="semibold">
                            {superActionFor.equipment.holder?.displayName ||
                              superActionFor.equipment.holder?.email ||
                              "the current holder"}
                          </Text>
                          .
                        </Text>
                        {superActionFor.action === "checkout" && (
                          <Text fontSize="xs" color="purple.700" mt={1}>
                            QR scan is bypassed — Super override.
                          </Text>
                        )}
                      </Box>
                    )}
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSuperActionFor(null);
                      setSuperPickerUserId("");
                    }}
                    disabled={superActionBusy}
                  >
                    Cancel
                  </Button>
                  <Button
                    colorPalette="purple"
                    loading={superActionBusy}
                    disabled={
                      superActionFor?.action === "reserve" && !superPickerUserId
                    }
                    onClick={async () => {
                      if (!superActionFor) return;
                      setSuperActionBusy(true);
                      try {
                        const { equipment, action } = superActionFor;
                        if (action === "reserve") {
                          await superReserveFor(equipment, superPickerUserId);
                        } else if (action === "cancel") {
                          await superCancelFor(equipment);
                        } else if (action === "checkout") {
                          await superCheckoutFor(equipment);
                        } else if (action === "return") {
                          await superReturnFor(equipment);
                        }
                      } finally {
                        setSuperActionBusy(false);
                        setSuperActionFor(null);
                        setSuperPickerUserId("");
                      }
                    }}
                  >
                    {superActionFor?.action === "reserve" && "Reserve"}
                    {superActionFor?.action === "cancel" && "Cancel reservation"}
                    {superActionFor?.action === "checkout" && "Check out"}
                    {superActionFor?.action === "return" && "Return"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* QR Auto-Action Confirmation Dialog (checkout/return via /e/[slug]) */}
      <Dialog.Root open={!!qrAction} onOpenChange={(e) => { if (!e.open) setQrAction(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>{qrAction?.action === "checkout" ? "Confirm Check Out" : "Confirm Return"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">{qrAction?.label}</Text>
                {qrAction?.action === "checkout" && (
                  <Text fontSize="xs" color="fg.muted" mt={2}>You scanned this equipment's QR code. Confirming will complete your checkout.</Text>
                )}
                {qrAction?.action === "return" && (
                  <Text fontSize="xs" color="fg.muted" mt={2}>You scanned this equipment's QR code. Confirming will return it and end your checkout.</Text>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setQrAction(null)} disabled={qrActionBusy}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette={qrAction?.action === "checkout" ? "green" : "blue"}
                    loading={qrActionBusy}
                    onClick={async () => {
                      if (!qrAction) return;
                      setQrActionBusy(true);
                      try {
                        if (qrAction.action === "checkout") {
                          await apiPost(`/api/equipment/${qrAction.equipmentId}/checkout/verify`, { slug: qrAction.slug });
                          publishInlineMessage({ type: "SUCCESS", text: "Equipment checked out." });
                        } else {
                          await apiPost(`/api/equipment/${qrAction.equipmentId}/return/verify`, { slug: qrAction.slug });
                          publishInlineMessage({ type: "SUCCESS", text: "Equipment returned." });
                        }
                        setQrAction(null);
                        void load();
                      } catch (err) {
                        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Action failed.", err) });
                      } finally {
                        setQrActionBusy(false);
                      }
                    }}
                  >
                    {qrAction?.action === "checkout" ? "Check Out" : "Return"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment Insights section — window-scoped leaderboard + idle list.
// Sourced from /api/admin/operations (same endpoint the header
// unclaimed-jobs badge uses). Local date range independent from the
// rest of the tab, which is not window-scoped.
// ─────────────────────────────────────────────────────────────────────────────

type InsightsEquipment = {
  total: number;
  available: number;
  checkedOut: number;
  reserved: number;
  inMaintenance: number;
  windowDays: number;
  windowCheckouts: number;
  windowIncome: number;
  windowDistinctUsed: number;
  leaderboard: {
    id: string;
    shortDesc: string | null;
    brand: string | null;
    model: string | null;
    type: string | null;
    checkouts: number;
    daysOut: number;
    income: number;
    utilizationPct: number;
    jobsBilled: number | null;
  }[];
  idle: {
    id: string;
    shortDesc: string | null;
    brand: string | null;
    model: string | null;
    type: string | null;
    status: string;
  }[];
};

type InsightsResponse = {
  equipment: InsightsEquipment;
};

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function EquipmentInsightsSection() {
  // Section header + collapse toggle live on the parent Dashboard, so
  // this component always renders its body when mounted.
  const [dateFrom, setDateFrom] = usePersistedState<string>("equip_insights_from", bizAddDays(bizToday(), -30));
  const [dateTo, setDateTo] = usePersistedState<string>("equip_insights_to", bizToday());
  const [view, setView] = usePersistedState<"table" | "chart">("equip_insightsView", "table");
  const [chartMetric, setChartMetric] = usePersistedState<
    "daysOut" | "jobsBilled" | "checkouts" | "income" | "utilizationPct"
  >("equip_insightsChartMetric", "daysOut");
  const [idleOpen, setIdleOpen] = useState(false);
  const [data, setData] = useState<InsightsEquipment | null>(null);
  const [loading, setLoading] = useState(false);

  const periodCollection = useMemo(
    () =>
      createListCollection({
        items: SUPER_PERIODS.map((p) => ({ label: p.label, value: periodKey(p) })),
      }),
    [],
  );

  const [refreshTick, setRefreshTick] = useState(0);
  // Global "refresh all sections" event from the tab's top toolbar.
  useEffect(() => {
    const on = () => setRefreshTick((t) => t + 1);
    window.addEventListener("inventory:refresh", on);
    return () => window.removeEventListener("inventory:refresh", on);
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        qs.set("from", dateFrom);
        qs.set("to", dateTo);
        const res = await apiGet<InsightsResponse>(`/api/admin/operations?${qs}`);
        if (!cancelled) setData(res.equipment);
      } catch {
        if (!cancelled) setData(null);
      }
      if (!cancelled) setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo, refreshTick]);

  return (
    <VStack align="stretch" gap={2}>
          {/* Date range strip */}
          <HStack gap={2} wrap="wrap" align="flex-end">
            <Box>
              <Text fontSize="2xs" color="fg.muted" mb={1}>From</Text>
              <Input type="date" size="sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </Box>
            <Box>
              <Text fontSize="2xs" color="fg.muted" mb={1}>To</Text>
              <Input type="date" size="sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </Box>
            {/* Timeframe dropdown — replaces the old "Last 30d" / "Last 7d"
                pair. Two buttons could only ever offer two windows, and
                widening the range meant typing dates by hand. The From/To
                inputs stay for genuinely custom ranges; picking a preset
                just fills them in, so there is one source of truth for the
                window and the fetch below is unchanged. */}
            <Box>
              <Text fontSize="2xs" color="fg.muted" mb={1}>Timeframe</Text>
              <Select.Root
                collection={periodCollection}
                value={[]}
                onValueChange={(e) => {
                  const k = e.value?.[0];
                  const next = SUPER_PERIODS.find((p) => periodKey(p) === k);
                  if (!next) return;
                  const r = periodToRange(next);
                  setDateFrom(r.from);
                  setDateTo(r.to);
                }}
                size="sm"
                positioning={{ strategy: "fixed", hideWhenDetached: true }}
              >
                <Select.Control>
                  <Select.Trigger w="auto" minW="150px" px="2">
                    {/* No ValueText: the From/To inputs beside this ARE the
                        current state, and a preset stops being true the
                        moment either date is edited. Showing a stale
                        "last week" next to contradicting dates would be
                        worse than showing nothing. */}
                    <Select.ValueText placeholder="Choose a range…" />
                    <Select.Indicator />
                  </Select.Trigger>
                </Select.Control>
                <Select.Positioner>
                  <Select.Content minW="var(--reference-width)">
                    {periodCollection.items.map((item) => (
                      <Select.Item key={item.value} item={item.value}>
                        <Select.ItemText>{item.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Select.Root>
            </Box>
          </HStack>

          {loading && <Box py={4} textAlign="center"><Spinner size="sm" /></Box>}

          {!loading && data && (
            <>
              {/* "Today" snapshot — current fleet state, NOT window-scoped. */}
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide" px={1}>Today</Text>
              <HStack gap={2} wrap="wrap">
                <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">Available: {data.available}</Badge>
                <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">Checked Out: {data.checkedOut}</Badge>
                <Badge colorPalette="yellow" variant="subtle" fontSize="xs" px="2" borderRadius="full">Reserved: {data.reserved}</Badge>
                <Badge colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full">Maintenance: {data.inMaintenance}</Badge>
                <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">Total: {data.total}</Badge>
              </HStack>

              {/* "In this window" — checkout-anchored usage stats. */}
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide" mt={2} px={1}>
                In This Window ({data.windowDays} {data.windowDays === 1 ? "day" : "days"})
              </Text>
              <Box display="grid" gridTemplateColumns="repeat(3, 1fr)" gap={2}>
                <InsightsMetric label="Checkouts" value={String(data.windowCheckouts)} color="blue.600" />
                <InsightsMetric label="Rental Income" value={fmtMoney(data.windowIncome)} color="green.600" />
                <InsightsMetric label="Pieces Used" value={`${data.windowDistinctUsed} / ${data.total}`} color="gray.700" />
              </Box>

              {data.leaderboard.length > 0 && (
                <EquipmentLeaderboard
                  leaderboard={data.leaderboard}
                  view={view}
                  setView={setView}
                  chartMetric={chartMetric}
                  setChartMetric={setChartMetric}
                />
              )}

              {data.leaderboard.length === 0 && data.idle.length > 0 && (
                <Text fontSize="xs" color="fg.muted" mt={1} px={1}>
                  No equipment was checked out in this window.
                </Text>
              )}

              {data.idle.length > 0 && (
                <Box>
                  <HStack
                    gap={1.5}
                    cursor="pointer"
                    onClick={() => setIdleOpen((v) => !v)}
                    _hover={{ color: "fg" }}
                    color="fg.muted"
                    userSelect="none"
                    py={1}
                    px={1}
                  >
                    {idleOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Text fontSize="xs" fontWeight="medium">
                      Idle ({data.idle.length}) — no checkouts in this window
                    </Text>
                  </HStack>
                  {idleOpen && (
                    <HStack gap={1} wrap="wrap" mt={1} px={1}>
                      {data.idle.map((e) => (
                        <Badge key={e.id} size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="2" borderRadius="full">
                          {e.shortDesc ?? "—"}
                          {(e.brand || e.model) && (
                            <Text as="span" color="fg.muted" ml={1}>
                              ({[e.brand, e.model].filter(Boolean).join(" ")})
                            </Text>
                          )}
                        </Badge>
                      ))}
                    </HStack>
                  )}
                </Box>
              )}
            </>
          )}
    </VStack>
  );
}

function InsightsMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Card.Root variant="outline">
      <Card.Body py="2" px="3">
        <Text fontSize="xl" fontWeight="bold" color={color} lineHeight="1">{value}</Text>
        <Text fontSize="xs" color="fg.muted" mt={1}>{label}</Text>
      </Card.Body>
    </Card.Root>
  );
}

function EquipmentLeaderboard({
  leaderboard,
  view,
  setView,
  chartMetric,
  setChartMetric,
}: {
  leaderboard: InsightsEquipment["leaderboard"];
  view: "table" | "chart";
  setView: (v: "table" | "chart") => void;
  chartMetric: "daysOut" | "jobsBilled" | "checkouts" | "income" | "utilizationPct";
  setChartMetric: (m: "daysOut" | "jobsBilled" | "checkouts" | "income" | "utilizationPct") => void;
}) {
  const METRICS = [
    { key: "daysOut" as const, label: "Days Out", color: "#3182CE", getter: (e: InsightsEquipment["leaderboard"][number]) => e.daysOut, tip: (v: number) => `${v}d` },
    { key: "jobsBilled" as const, label: "Jobs Billed", color: "#319795", getter: (e: InsightsEquipment["leaderboard"][number]) => e.jobsBilled ?? 0, tip: (v: number) => `${v}` },
    { key: "checkouts" as const, label: "Checkouts", color: "#805AD5", getter: (e: InsightsEquipment["leaderboard"][number]) => e.checkouts, tip: (v: number) => `${v}` },
    { key: "income" as const, label: "Income", color: "#38A169", getter: (e: InsightsEquipment["leaderboard"][number]) => Math.round(e.income * 100) / 100, tip: (v: number) => `$${v.toFixed(2)}` },
    { key: "utilizationPct" as const, label: "Utilization", color: "#D69E2E", getter: (e: InsightsEquipment["leaderboard"][number]) => e.utilizationPct, tip: (v: number) => `${v}%` },
  ];
  const activeMetric = METRICS.find((m) => m.key === chartMetric) ?? METRICS[0];
  const chartData = leaderboard
    .map((e) => ({ name: e.shortDesc ?? e.id, value: activeMetric.getter(e) }))
    .sort((a, b) => b.value - a.value);
  const truncName = (n: string) => (n.length > 22 ? n.slice(0, 21) + "…" : n);
  return (
    <>
      <HStack gap={2} mt={2} mb={2} wrap="wrap" align="center">
        {view === "chart" ? (
          <HStack gap={1} wrap="wrap" flex="1" minW={0}>
            {METRICS.map((m) => (
              <Badge
                key={m.key}
                size="sm"
                variant={chartMetric === m.key ? "solid" : "outline"}
                colorPalette="gray"
                cursor="pointer"
                onClick={() => setChartMetric(m.key)}
              >
                {m.label}
              </Badge>
            ))}
          </HStack>
        ) : (
          <Box flex="1" minW={0} />
        )}
        <HStack gap={0} borderWidth="1px" borderColor="gray.300" borderRadius="md" overflow="hidden" flexShrink={0}>
          <Button
            size="xs"
            variant={view === "table" ? "solid" : "ghost"}
            colorPalette={view === "table" ? "blue" : undefined}
            borderRadius="0"
            onClick={() => setView("table")}
            title="Table view"
          >
            <LayoutGrid size={12} />
          </Button>
          <Button
            size="xs"
            variant={view === "chart" ? "solid" : "ghost"}
            colorPalette={view === "chart" ? "blue" : undefined}
            borderRadius="0"
            onClick={() => setView("chart")}
            title="Chart view"
          >
            <BarChart3 size={12} />
          </Button>
        </HStack>
      </HStack>

      {view === "table" && (
        <Card.Root variant="outline">
          <Card.Body py="2" px="0">
            <HStack px={3} py={1} borderBottomWidth="1px" borderColor="gray.200" fontSize="xs" fontWeight="semibold" color="fg.muted" gap={2}>
              <Text flex="1" minW={0}>Equipment</Text>
              <Text w="55px" textAlign="right">Days</Text>
              <Text w="50px" textAlign="right" display={{ base: "none", sm: "block" }} title="Number of billed jobs across the window (per-job billing)">Jobs</Text>
              <Text w="55px" textAlign="right">Rentals</Text>
              <Text w="70px" textAlign="right" display={{ base: "none", md: "block" }}>Income</Text>
              <Text w="55px" textAlign="right">Util %</Text>
            </HStack>
            {leaderboard.map((e) => (
              <HStack key={e.id} px={3} py={1.5} borderBottomWidth="1px" borderColor="gray.50" fontSize="xs" gap={2}
                _hover={{ bg: "gray.50" }}
              >
                <VStack align="start" gap={0} flex="1" minW={0}>
                  <Text fontWeight="medium" truncate>{e.shortDesc ?? "—"}</Text>
                  {(e.brand || e.model) && (
                    <Text color="fg.muted" fontSize="2xs" truncate>
                      {[e.brand, e.model].filter(Boolean).join(" ")}
                    </Text>
                  )}
                </VStack>
                <Text w="55px" textAlign="right" color="blue.600" fontWeight="medium">{e.daysOut}</Text>
                <Text w="50px" textAlign="right" color="teal.600" display={{ base: "none", sm: "block" }}>
                  {e.jobsBilled != null ? e.jobsBilled : "—"}
                </Text>
                <Text w="55px" textAlign="right" color="fg.muted">{e.checkouts}</Text>
                <Text w="70px" textAlign="right" color="green.600" display={{ base: "none", md: "block" }}>{fmtMoney(e.income)}</Text>
                <Text w="55px" textAlign="right" color={e.utilizationPct >= 50 ? "green.600" : e.utilizationPct > 0 ? "orange.600" : "fg.muted"}>{e.utilizationPct}%</Text>
              </HStack>
            ))}
          </Card.Body>
        </Card.Root>
      )}

      {view === "chart" && (
        <Card.Root variant="outline">
          <Card.Body py="3" px="2">
            <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 28)}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={11} tickFormatter={(v: number) => activeMetric.tip(v)} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={150}
                  tick={{ fontSize: 10, style: { fontSize: "10px" } }}
                  tickFormatter={truncName}
                />
                <Tooltip formatter={(v: any) => [activeMetric.tip(Number(v)), activeMetric.label]} />
                <Bar dataKey="value" fill={activeMetric.color} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card.Body>
        </Card.Root>
      )}
    </>
  );
}

// ─── Usage breakdown ─────────────────────────────────────────────
// Absorbed from the retired EquipmentUsageTab. Renders a summary
// strip + a group-by picker (equipment / collection / day, plus
// Person for admin+super) + expandable checkout rows. Data source
// depends on scope:
//   • purpose="WORKER"  → /api/equipment-usage      (own history)
//   • purpose="SUPER"   → /api/admin/equipment-usage (fleet-wide)
// Uses its own persisted date range + group-by state so the mount
// site (Worker Inventory vs Super Insights) doesn't have to thread
// props through.

type UsagePurpose = "WORKER" | "SUPER";
type UsagePreset = "all" | "7" | "30" | "90" | "365";
type UsageGroupBy = "person" | "equipment" | "collection" | "day";

type UsageRow = {
  id: string;
  equipmentId: string;
  equipment: { id: string; shortDesc?: string | null; brand?: string | null; model?: string | null; type?: string | null; qrSlug?: string | null };
  user: { id: string; displayName?: string | null; email?: string | null } | null;
  group: { id: string; name: string } | null;
  checkedOutAt: string | null;
  releasedAt: string | null;
  rentalDays: number | null;
  active: boolean;
};

type UsageCollection = { id: string; name: string; items: { equipmentId: string }[] };

const USAGE_PRESETS: { key: UsagePreset; label: string }[] = [
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "365", label: "Last year" },
  { key: "all", label: "All time" },
];

function usageRangeForPreset(p: UsagePreset): { from: string; to: string } {
  if (p === "all") return { from: "", to: "" };
  const days = Number(p);
  const to = bizToday();
  return { from: bizAddDays(to, -days), to };
}

function usageEquipmentLabel(e: UsageRow["equipment"]): string {
  if (e.shortDesc) return e.shortDesc;
  const parts = [e.brand, e.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (e.type) return e.type;
  return e.id.slice(-6);
}

function usagePersonLabel(u: UsageRow["user"]): string {
  if (!u) return "Unknown";
  return u.displayName || u.email || u.id.slice(-6);
}

function usageDaysOut(c: UsageRow): number {
  if (!c.checkedOutAt) return 0;
  const start = new Date(c.checkedOutAt).getTime();
  const end = c.releasedAt ? new Date(c.releasedAt).getTime() : Date.now();
  // date-handling-allow: constant ms-per-day is the correct unit here — the
  // start/end are ISO instants, not calendar dates, so DST doesn't apply.
  return Math.max(1, Math.ceil((end - start) / 86400000));
}

function UsageBreakdown({ purpose }: { purpose: UsagePurpose }) {
  const isSuper = purpose === "SUPER";
  const pfx = `usage_${purpose.toLowerCase()}`;
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [collections, setCollections] = useState<UsageCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = usePersistedState<UsagePreset>(`${pfx}_preset`, "30");
  const [groupBy, setGroupBy] = usePersistedState<UsageGroupBy>(
    `${pfx}_groupBy`,
    isSuper ? "person" : "equipment",
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [refreshTick, setRefreshTick] = useState(0);
  // Global "refresh all sections" event from the tab's top toolbar.
  useEffect(() => {
    const on = () => setRefreshTick((t) => t + 1);
    window.addEventListener("inventory:refresh", on);
    return () => window.removeEventListener("inventory:refresh", on);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const { from, to } = usageRangeForPreset(preset);
        const qs = new URLSearchParams();
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        const base = isSuper ? "/api/admin/equipment-usage" : "/api/equipment-usage";
        const [usage, cols] = await Promise.all([
          apiGet<UsageRow[]>(`${base}?${qs}`),
          apiGet<UsageCollection[]>("/api/equipment-collections"),
        ]);
        if (cancelled) return;
        setRows(Array.isArray(usage) ? usage : []);
        setCollections(Array.isArray(cols) ? cols : []);
      } catch (err) {
        if (!cancelled) publishInlineMessage({ type: "ERROR", text: getErrorMessage("Usage load failed.", err) });
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [preset, isSuper, refreshTick]);

  const equipmentCollections = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of collections) {
      for (const it of c.items) {
        const arr = map.get(it.equipmentId) ?? [];
        arr.push(c.name);
        map.set(it.equipmentId, arr);
      }
    }
    return map;
  }, [collections]);

  const summary = useMemo(() => {
    const distinctEquipment = new Set(rows.map((r) => r.equipmentId));
    const activeCount = rows.filter((r) => r.active).length;
    const totalDays = rows.reduce((sum, r) => sum + usageDaysOut(r), 0);
    return {
      checkouts: rows.length,
      equipment: distinctEquipment.size,
      active: activeCount,
      totalDays,
    };
  }, [rows]);

  type Group = { key: string; label: string; rows: UsageRow[]; days: number };
  const groups = useMemo<Group[]>(() => {
    const buckets = new Map<string, { label: string; rows: UsageRow[] }>();
    const add = (key: string, label: string, row: UsageRow) => {
      const b = buckets.get(key) ?? { label, rows: [] };
      b.rows.push(row);
      buckets.set(key, b);
    };
    for (const r of rows) {
      if (groupBy === "person") {
        add(r.user?.id ?? "unknown", usagePersonLabel(r.user), r);
      } else if (groupBy === "equipment") {
        add(r.equipmentId, usageEquipmentLabel(r.equipment), r);
      } else if (groupBy === "day") {
        const key = r.checkedOutAt ? bizDateKey(r.checkedOutAt) : "unknown";
        const label = r.checkedOutAt
          ? fmtDateOpts(r.checkedOutAt, { weekday: "short", month: "short", day: "numeric" })
          : "Unknown date";
        add(key, label, r);
      } else {
        const names = equipmentCollections.get(r.equipmentId) ?? [];
        if (names.length === 0) {
          add("__none__", "Not in a collection", r);
        } else {
          for (const n of names) add(`col:${n}`, n, r);
        }
      }
    }
    const list: Group[] = Array.from(buckets.entries()).map(([key, b]) => ({
      key,
      label: b.label,
      rows: b.rows,
      days: b.rows.reduce((s, r) => s + usageDaysOut(r), 0),
    }));
    if (groupBy === "day") list.sort((a, b) => (a.key < b.key ? 1 : -1));
    else list.sort((a, b) => b.rows.length - a.rows.length);
    return list;
  }, [rows, groupBy, equipmentCollections]);

  const groupModes: { key: UsageGroupBy; label: string }[] = isSuper
    ? [
        { key: "person", label: "Person" },
        { key: "equipment", label: "Equipment" },
        { key: "collection", label: "Collection" },
        { key: "day", label: "Day" },
      ]
    : [
        { key: "equipment", label: "Equipment" },
        { key: "collection", label: "Collection" },
        { key: "day", label: "Day" },
      ];

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <VStack align="stretch" gap={2}>
      <HStack gap={2} flexWrap="wrap">
        {USAGE_PRESETS.map((p) => (
          <Button
            key={p.key}
            size="xs"
            variant={preset === p.key ? "solid" : "outline"}
            colorPalette={preset === p.key ? "blue" : "gray"}
            onClick={() => setPreset(p.key)}
          >
            {p.label}
          </Button>
        ))}
      </HStack>

      {loading ? (
        <Spinner size="sm" />
      ) : (
        <>
          <SimpleGrid columns={{ base: 2, md: 4 }} gap={2}>
            <UsageSummaryCard label="Checkouts" value={summary.checkouts} />
            <UsageSummaryCard label="Equipment used" value={summary.equipment} />
            <UsageSummaryCard label="Out now" value={summary.active} colorPalette={summary.active > 0 ? "blue" : undefined} />
            <UsageSummaryCard label="Total days" value={summary.totalDays} />
          </SimpleGrid>

          <HStack gap={2} flexWrap="wrap">
            <Text fontSize="xs" color="fg.muted">Group by</Text>
            {groupModes.map((m) => (
              <Button
                key={m.key}
                size="xs"
                variant={groupBy === m.key ? "solid" : "outline"}
                colorPalette={groupBy === m.key ? "teal" : "gray"}
                onClick={() => { setGroupBy(m.key); setExpanded(new Set()); }}
              >
                {m.label}
              </Button>
            ))}
          </HStack>

          {groups.length === 0 ? (
            <Card.Root variant="outline">
              <Card.Body py={6} textAlign="center">
                <Text color="fg.muted" fontSize="sm">No equipment usage in this window.</Text>
              </Card.Body>
            </Card.Root>
          ) : (
            groups.map((g) => {
              const open = expanded.has(g.key);
              return (
                <Card.Root key={g.key} variant="outline">
                  <Card.Body py="2" px="3">
                    <HStack justify="space-between" cursor="pointer" onClick={() => toggle(g.key)}>
                      <HStack gap={2} minW={0}>
                        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        <Text fontWeight="semibold" lineHeight="1.2">{g.label}</Text>
                      </HStack>
                      <HStack gap={1.5} flexShrink={0}>
                        <Badge size="sm" colorPalette="gray">
                          {g.rows.length} checkout{g.rows.length === 1 ? "" : "s"}
                        </Badge>
                        <Badge size="sm" colorPalette="purple">{g.days} day{g.days === 1 ? "" : "s"}</Badge>
                      </HStack>
                    </HStack>
                    {open && (
                      <VStack align="stretch" gap={1} mt={2}>
                        {g.rows.map((r) => {
                          const ctx: string[] = [];
                          if (groupBy !== "equipment") ctx.push(usageEquipmentLabel(r.equipment));
                          if (isSuper && groupBy !== "person") ctx.push(usagePersonLabel(r.user));
                          if (r.group) ctx.push(r.group.name);
                          return (
                            <HStack key={r.id} justify="space-between" gap={2} px={2} py={1.5} borderRadius="md" bg="bg.subtle">
                              <VStack align="start" gap={0} minW={0}>
                                <Text fontSize="sm" lineHeight="1.3">
                                  {fmtDateShort(r.checkedOutAt)} → {r.active ? "out" : fmtDateShort(r.releasedAt)}
                                </Text>
                                {ctx.length > 0 && (
                                  <Text fontSize="xs" color="fg.muted">{ctx.join(" · ")}</Text>
                                )}
                              </VStack>
                              <HStack gap={1.5} flexShrink={0}>
                                {r.active && <Badge size="sm" colorPalette="blue">Out</Badge>}
                                <Badge size="sm" colorPalette="purple">{usageDaysOut(r)}d</Badge>
                              </HStack>
                            </HStack>
                          );
                        })}
                      </VStack>
                    )}
                  </Card.Body>
                </Card.Root>
              );
            })
          )}
        </>
      )}
    </VStack>
  );
}

function UsageSummaryCard(props: { label: string; value: number; colorPalette?: string }) {
  return (
    <Card.Root variant="outline">
      <Card.Body py="2" px="3">
        <Text fontSize="xl" fontWeight="bold" color={props.colorPalette ? `${props.colorPalette}.600` : undefined}>
          {props.value}
        </Text>
        <Text fontSize="xs" color="fg.muted">{props.label}</Text>
      </Card.Body>
    </Card.Root>
  );
}
