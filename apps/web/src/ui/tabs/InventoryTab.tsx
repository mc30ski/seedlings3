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
import { scopeFromMe } from "@/src/lib/roles";
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
import { ViewAsSelector, ViewAsBadges, type ViewAsWorker } from "@/src/ui/tabs/JobsTab.parts";

import { EQUIPMENT_KIND, EQUIPMENT_STATUS } from "@/src/lib/types";
import { parseEquipmentKindsConfig, type EquipmentKindConfig } from "@/src/lib/equipmentSuggestions";
import { Dashboard } from "@/src/ui/components/Dashboard";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import {
  FULL_PERIODS,
  periodKey,
  periodToRange,
} from "@/src/ui/components/WorkerHourlyPayCard";
import type { Scope } from "@/src/lib/scope";
import { isFeeable } from "@repo/money";

// Kind states are now derived from loaded items (see useMemo below)

// Constant representing the status states for this entity.
const workerStatusStates = [
  "ALL",
  "CLAIMED",
  "AVAILABLE",
  "UNAVAILABLE",
] as const;
const manageStatusStates = ["ALL", ...EQUIPMENT_STATUS] as const;

// Card action bands — staff buttons split into three
// capability-labelled bands so the reader sees at a glance which capability
// tier each button belongs to. Mirrors the pattern used by
// ElevatedActionRow on the Jobs tab: subtle top-bordered band with
// a leading colored badge and the wrap-flow buttons trailing.
function CardActionBands(props: {
  e: Equipment;
  loading: boolean;
  statusButtonBusyId: string;
  setStatusButtonBusyId: (v: string) => void;
  canViewEquipment: boolean;
  canManageEquipment: boolean;
  cannotPullInventory: boolean;
  viewAsUserId: string | null;
  viewAsUserName: string | null;
  canSubjectCheckout: boolean;
  canSubjectCancel: boolean;
  canSubjectReturn: boolean;
  canSubjectReserve: boolean;
  canForceRelease: boolean;
  canStartMaintenance: boolean;
  canEndMaintenance: boolean;
  canRetire: boolean;
  canUnretire: boolean;
  canHardDelete: boolean;
  canReserveForOther: boolean;
  canCancelForOther: boolean;
  canCheckoutForOther: boolean;
  canReturnForOther: boolean;
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
  onReserveForOther: () => void;
  onCancelForOther: () => void;
  onCheckoutForOther: () => void;
  onReturnForOther: () => void;
}) {
  const {
    e, loading, statusButtonBusyId, setStatusButtonBusyId,
    canViewEquipment, canManageEquipment, cannotPullInventory,
    viewAsUserId, viewAsUserName,
    canSubjectCheckout, canSubjectCancel, canSubjectReturn, canSubjectReserve,
    canForceRelease, canStartMaintenance, canEndMaintenance,
    canRetire, canUnretire, canHardDelete,
    canReserveForOther, canCancelForOther, canCheckoutForOther, canReturnForOther,
    onEdit, onWorkerCheckout, onWorkerCancel, onWorkerReturn, onWorkerReserve,
    onForceRelease, onStartMaintenance, onEndMaintenance, onRetire, onUnretire,
    onHardDelete, onReserveForOther, onCancelForOther, onCheckoutForOther, onReturnForOther,
  } = props;

  const holderLabel = e.holder?.displayName || e.holder?.email || "holder";

  // Worker band — surfaces only when at least one worker action is
  // available (own reserve/checkout/cancel/return, or the trainee
  // gate hint). Empty band would be visual noise on admin cards with
  // nothing to reserve.
  const showNoClearanceHint = canViewEquipment && e.status === "AVAILABLE" && cannotPullInventory && !viewAsUserId;
  const showSubjectBand =
    canSubjectCheckout || canSubjectCancel || canSubjectReturn || canSubjectReserve || showNoClearanceHint;
  // Admin band always renders when scope includes admin — the "Edit"
  // button anchors it, and the other Admin buttons appear as their
  // per-status guards permit.
  const showTopBand =
    canReserveForOther || canCancelForOther || canCheckoutForOther || canReturnForOther || canHardDelete;

  if (!showSubjectBand && !canManageEquipment && !showTopBand) return null;

  const bandProps = {
    px: 3, py: 1.5, gap: 2, wrap: "wrap" as const,
    borderTopWidth: "1px", borderColor: "blackAlpha.100",
    bg: "blackAlpha.50",
  };

  return (
    <VStack align="stretch" gap={0}>
      {showSubjectBand && (
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
          {canSubjectReserve && (
            <StatusButton id="equipment-reserve" itemId={e.id} label="Reserve" onClick={async () => onWorkerReserve()}
              variant="solid" colorPalette="green" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSubjectCheckout && (
            <StatusButton id="equipment-checkout" itemId={e.id} label="Check Out" onClick={async () => onWorkerCheckout()}
              variant="solid" colorPalette="blue" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSubjectReturn && (
            <StatusButton id="equipment-return" itemId={e.id} label="Return" onClick={async () => onWorkerReturn()}
              variant="solid" colorPalette="orange" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canSubjectCancel && (
            <StatusButton id="equipment-cancel" itemId={e.id} label="Cancel Reservation" onClick={async () => onWorkerCancel()}
              variant="outline" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {/* NAMED FOR THE CAPABILITY, NOT FOR A ROLE. This read
              "Trainees cannot reserve equipment", which was wrong twice:
              Trainee is a CustomRole an operator can rename or delete, and
              the hint shows for anyone missing the capability — a
              bookkeeper saw it too. It also named the wrong rule; see
              `canSubjectReserve`. */}
          {showNoClearanceHint && (
            <HStack gap={1} fontSize="xs" color="gray.fg"><AlertTriangle size={12} /><Text>You do not have permission to reserve equipment.</Text></HStack>
          )}
        </HStack>
      )}
      {canManageEquipment && (
        <HStack {...bandProps}>
          <Badge size="xs" variant="subtle" colorPalette="purple">Admin</Badge>
          <StatusButton id="equipment-edit" itemId={e.id} label="Edit" onClick={async () => onEdit()}
            variant="outline" disabled={loading}
            busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          {canForceRelease && (
            <StatusButton id="equipment-forceRelease" itemId={e.id} label="Force release" onClick={async () => onForceRelease()}
              variant="solid" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canStartMaintenance && (
            <StatusButton id="equipment-startMaintenance" itemId={e.id} label="Start maintenance" onClick={async () => onStartMaintenance()}
              variant="subtle" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canEndMaintenance && (
            <StatusButton id="equipment-endMaintenance" itemId={e.id} label="End maintenance" onClick={async () => onEndMaintenance()}
              variant="subtle" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canRetire && (
            <StatusButton id="equipment-retire" itemId={e.id} label="Retire" onClick={async () => onRetire()}
              variant="outline" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canUnretire && (
            <StatusButton id="equipment-unretire" itemId={e.id} label="Unretire" onClick={async () => onUnretire()}
              variant="subtle" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
        </HStack>
      )}
      {showTopBand && (
        <HStack {...bandProps}>
          <Badge size="xs" variant="subtle" colorPalette="orange">
            <HStack gap={0.5}><Zap size={9} /><Text>Super</Text></HStack>
          </Badge>
          {canReserveForOther && (
            <StatusButton id="equipment-super-reserve-for" itemId={e.id} label="Reserve for worker…"
              onClick={async () => onReserveForOther()}
              variant="subtle" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canCancelForOther && (
            <StatusButton id="equipment-super-cancel-for" itemId={e.id} label={`Cancel for ${holderLabel}`}
              onClick={async () => onCancelForOther()}
              variant="subtle" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canCheckoutForOther && (
            <StatusButton id="equipment-super-checkout-for" itemId={e.id} label={`Checkout for ${holderLabel}`}
              onClick={async () => onCheckoutForOther()}
              variant="solid" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canReturnForOther && (
            <StatusButton id="equipment-super-return-for" itemId={e.id} label={`Return for ${holderLabel}`}
              onClick={async () => onReturnForOther()}
              variant="solid" colorPalette="purple" disabled={loading}
              busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
          )}
          {canHardDelete && (
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
  /** What the caller may do, as capabilities.
   *  `equipment.view`   → the list, filters, detail, and the self-service
   *                       actions: like / pin / reserve for yourself or
   *                       your crew / take a kit.
   *  `reports.view`     → the Insights rollups.
   *  `equipment.manage` → edit/force-release/maintenance/retire, acting on
   *                       behalf of another holder, and photo editing. */
  scope?: Scope;
};

/**
 * What to CALL a piece of equipment on screen.
 *
 * `shortDesc` is `String?` in the schema and every other identifying field
 * is too, so a row can legitimately arrive with nothing to show. The web
 * `Equipment` type claimed `shortDesc: string`, which is why nothing warned
 * about `a.shortDesc.localeCompare(b.shortDesc)` in the list sort — three
 * blank rows reached the database and the tab died with "Failed to load
 * equipment null is not an object", blaming the fetch for a crash in the
 * comparator. The types are honest now; this is the one place that decides
 * what to render when they are empty.
 *
 * Falls back the way the collections list already did, so the same piece of
 * equipment reads the same in both places.
 */
export function equipmentLabel(eq: {
  id: string;
  shortDesc?: string | null;
  brand?: string | null;
  model?: string | null;
  type?: string | null;
}): string {
  if (eq.shortDesc) return eq.shortDesc;
  const parts = [eq.brand, eq.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (eq.type) return eq.type;
  // Last resort: a stable handle you can read out to somebody, rather
  // than an empty row you cannot refer to at all.
  return `Untitled (${eq.id.slice(-6)})`;
}

export default function InventoryTab({ me, scope }: InventoryTabProps) {

  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from `purpose` for any callsite still on the old shape.
  const effScope = scope ?? {
    // Derived from CAPABILITIES, not from the shell that mounted
    // this tab. These three read `purpose` and so answered
    // "what may I do" with "where did you come from".
    ...scopeFromMe(me),
    
  };
  // Capabilities render additively AND are strictly governed by the
  // scope prop. Every control asks for the capability its own endpoint is
  // guarded on, so there is no second vocabulary that can drift from the
  // server's answer.
  const canViewEquipment = effScope.can("equipment.view");
  // What this actually gates, per the route map.
  const canManageEquipment = effScope.can("equipment.manage");
  const canViewReports = effScope.can("reports.view");
  const canViewBusinessReports = effScope.can("reports.business");

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  // Persisted-state prefix: self-scoped-only view gets its own bucket so
  // filters don't collide with the management view on the same device.
  const pfx = canManageEquipment ? "equip_a" : "equip_w";
  const [compact, setCompact] = usePersistedState(`${pfx}_compact`, false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(
    `${pfx}_status`, canManageEquipment ? ["ALL"] : ["CLAIMED"]
  );
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);
  const [likedOnly, setLikedOnly] = usePersistedState<boolean>(`${pfx}_likedOnly`, false);
  // "Filter to a specific worker" (`equipment.manage`, which is what gates
  // the picker) — also pre-set externally from HomeTab tile click-throughs
  // so this tab shows only what that worker has reserved or checked out.
  // Multi-select array to mirror JobsTab's pattern.
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

  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  /** Has the first fetch finished? Not the same as `loading`, which starts
   *  false while the fetch is kicked off by an effect that runs after the
   *  first paint — so the empty state was announced before anything had
   *  been asked for. See the longer note in ClientsTab. */
  const [hasLoaded, setHasLoaded] = useState(false);
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
  // Equipment Collections — kits a caller with `equipment.manage` has defined. Workers see them at
  // the top of the tab as "Reserve kit" shortcuts; the action loops the
  // existing per-piece reserve() call.
  type CollectionItem = { id: string; equipmentId: string; equipment: { id: string; shortDesc?: string | null; type?: string | null; brand?: string | null; model?: string | null; status?: string | null; retiredAt?: string | null } };
  type Collection = { id: string; name: string; description?: string | null; items: CollectionItem[] };
  const [collections, setCollections] = useState<Collection[]>([]);
  // Per-card expansion state for collection cards. Click the chevron to reveal
  // the description + member equipment list (matches what the Equipment
  // CollectionsTab shows for each kit).
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
  // it to drill into "what's in this kit"; holders of `equipment.manage` use it to scope bulk actions
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
    // Fetch the caller's crew-lead groups regardless of what else they
    // hold. Somebody who manages equipment AND leads a crew should still
    // see their group card — the endpoint returns [] for anyone who leads
    // no crew, so this is a no-op for them.
    if (!canViewEquipment) return;
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
  }, [canViewEquipment]);

  // Hand-off from JobsTab: when a worker clicks a preferred-equipment chip
  // on a group-claimed job, the chip sets `reserveAsGroupId` so the picker
  // here lands on the right group without a manual click. Reads + clears
  // on mount and on every navigate-to-equipment event (so the same handoff
  // works even if this tab is already mounted in the background).
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
  // Workers list — only used by the worker-filter chip to look up names.
  const [viewAsWorkers, setViewAsWorkers] = useState<Array<{ id: string; displayName?: string | null; email?: string | null }>>([]);
  useEffect(() => {
    if (!canManageEquipment) return;
    apiGet<Array<{ id: string; displayName?: string | null; email?: string | null }>>("/api/workers")
      .then((list) => setViewAsWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [canManageEquipment]);
  const viewAsWorkerName = (id: string) => {
    const w = viewAsWorkers.find((x) => x.id === id);
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

  // "Act on behalf" state (`equipment.manage`). When `action === "reserve"`
  // the dialog includes a worker picker (the worker isn't already implied
  // by an active checkout). For the other three actions the current holder
  // is the implied target, so the dialog is just a confirm.
  const [actOnBehalfFor, setActOnBehalfFor] = useState<
    | { equipment: Equipment; action: "reserve" | "cancel" | "checkout" | "return" }
    | null
  >(null);
  const [onBehalfUserId, setOnBehalfUserId] = useState<string>("");
  const [onBehalfBusy, setOnBehalfBusy] = useState(false);

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
      (canManageEquipment ? manageStatusStates : workerStatusStates).map((s) => ({
        label: s === "ALL" ? "All Statuses" : prettyStatus(s),
        value: s,
      })),
    [canManageEquipment]
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  // Worker picker collection — the "act on behalf" dialog uses this to
  // pick the target worker for a reserve action. Sorted by display name.
  const workerItems = useMemo(
    () =>
      viewAsWorkers
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
    [viewAsWorkers],
  );
  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems],
  );

  // Main function to load all the items from the API.
  async function load(displayLoading: boolean = true) {
    setLoading(displayLoading);
    let list: Equipment[];
    try {
      // ONLY THE FETCH IS IN THE TRY.
      //
      // The sort used to live in here, so when the comparator threw on a
      // null `shortDesc` the catch reported "Failed to load equipment" —
      // pointing at the network for a bug three lines below it, with the
      // real message ("null is not an object") smuggled in as the cause.
      // A catch wrapped around rendering logic turns every client-side
      // crash into a server accusation.
      list = await apiGet("/api/equipment/all");
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load equipment", err),
      });
      setItems([]);
      setLoading(false);
      setHasLoaded(true);
      return;
    }
    try {
      setItems([...list].sort((a, b) => equipmentLabel(a).localeCompare(equipmentLabel(b))));
    } finally {
      setLoading(false);
      setHasLoaded(true);
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
        if (canViewEquipment) setLikedOnly(false);
        if (canManageEquipment) setWorkerFilter([]);
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
    const settingsPath = canManageEquipment ? "/api/settings" : "/api/settings";
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
  }, [canManageEquipment, viewAsUserId]);

  // Re-apply hand-off filters whenever someone navigates to this tab.
  // The chip click sets sessionStorage *then* dispatches the navigate
  // event, so by the time this handler runs the key is present. Super
  // scope dispatches its own event to keep cross-tab wiring correct
  // (previously piggybacked on navigate:staffTab, which routed clicks
  // into the wrong inner-tab space).
  useEffect(() => {
    const eventName =
      canViewReports
        ? "navigate:staffTab"
        : canManageEquipment
          ? "navigate:staffTab"
          : "navigate:staffTab";
    function handler(ev: Event) {
      const detail = (ev as CustomEvent).detail;
      if (detail?.tab !== "equipment") return;
      applyHandoffFilters();
    }
    window.addEventListener(eventName, handler as EventListener);
    return () => window.removeEventListener(eventName, handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewReports, canManageEquipment]);

  // Self-scoped-only: load pinned + liked equipment
  useEffect(() => {
    if (!canViewEquipment) return;
    apiGet<string[]>("/api/equipment/pinned")
      .then((ids) => setPinnedIds(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => {});
    apiGet<string[]>("/api/equipment/liked")
      .then((ids) => setLikedIds(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => {});
  }, [canViewEquipment]);

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
    const url = `${window.location.origin}/?equipment=${equipmentId}`;
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
              bg="bg.panel"
              borderWidth="1px"
              borderColor="gray.emphasized"
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
              {canViewEquipment && (
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
    // Return the disposer — dropping it leaks a listener per mount, each
    // holding this render's setQ in closure.
    return onEventSearchRun("activityTavToEquipmentTabQRCodeSearch", setQ, inputRef);
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
      || (canViewEquipment && likedOnly)
      || (canManageEquipment && workerFilter.length > 0)
      || !!collectionFilter
      || !!highlightId;
    if (hasFilters && !filtersActiveRef.current) {
      setCollectionsCollapsed(true);
    }
    filtersActiveRef.current = hasFilters;
  }, [q, kind, statusFilter, likedOnly, workerFilter, collectionFilter, highlightId, canViewEquipment, canManageEquipment]);
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
      setQrAction({ equipmentId: match.id, slug, action: "checkout", label: `Check out "${equipmentLabel(match)}"?` });
    } else if (match.status === "CHECKED_OUT") {
      // User has it checked out — offer return
      setQrAction({ equipmentId: match.id, slug, action: "return", label: `Return "${equipmentLabel(match)}"?` });
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
      if (canManageEquipment) {
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
    if (canViewEquipment && likedOnly) {
      rows = rows.filter((r) => likedIds.has(r.id));
    }

    // Worker filter (admin) — show only equipment whose current holder is one of the
    // selected workers. Items with no holder fall out, since the filter is "what does
    // worker X have right now."
    if (canManageEquipment && workerFilter.length > 0) {
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
  }, [items, q, kind, statusFilter, canManageEquipment, canViewEquipment, likedOnly, likedIds, highlightId, workerFilter, collectionFilter, collections]);

  // Split into Pinned + Claimed + Available + Unavailable groups (self-scoped view only).
  const groups = useMemo(() => {
    if (!canViewEquipment) {
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
  }, [filtered, pinnedIds, canViewEquipment, me]);

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
      // Management view-as: bypass the worker's own endpoint and route the
      // checkout through the act-on-behalf endpoint with the picked worker id.
      if (viewAsUserId && canManageEquipment) {
        await apiPost(`/api/equipment/${id}/checkout-for/verify`, {
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
  // sends the equipment's own qrSlug through the act-on-behalf endpoint so the
  // scan-verify check inside the service still passes.
  async function doReturn(e: Equipment) {
    setStatusButtonBusyId(`equipment-return${e.id}`);
    try {
      if (viewAsUserId && canManageEquipment) {
        await apiPost(`/api/equipment/${e.id}/return-for/verify`, {
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
        text: `Equipment '${e.qrSlug ?? equipmentLabel(e)}' successfully returned.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug ?? equipmentLabel(e)}' return failed.`, err),
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
      if (viewAsUserId && canManageEquipment) {
        // Management view-as: reserve on behalf of the picked worker via
        // the act-on-behalf endpoint. Group scope is only meaningful for the
        // actual worker (who leads groups), so we drop groupId here.
        await apiPost(`/api/equipment/${e.id}/reserve-for`, {
          userId: viewAsUserId,
        });
      } else {
        await apiPost(`/api/equipment/${e.id}/reserve`, groupId ? { groupId } : {});
      }
      notifyEquipmentUpdated();
      await load(false);
      const groupName = groupsAsClaimer.find((g) => g.id === groupId)?.name;
      const asName = viewAsUserId ? viewAsWorkerName(viewAsUserId) : null;
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
        // user only sees one surface.
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
          if (viewAsUserId && canManageEquipment) {
            await apiPost(`/api/equipment/${i.equipmentId}/reserve-for`, {
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
      if (viewAsUserId && canManageEquipment) {
        await apiPost(`/api/equipment/${e.id}/reserve-for/cancel`, {
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
      await apiPost(`/api/equipment/${e.id}/release`);
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
      await apiPost(`/api/equipment/${e.id}/maintenance/start`);
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
      await apiPost(`/api/equipment/${e.id}/maintenance/end`);
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
      await apiPost(`/api/equipment/${e.id}/retire`);
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
      await apiPost(`/api/equipment/${e.id}/unretire`);
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
      await apiDelete(`/api/equipment/${id}`);
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

  // ── "Act on behalf" handlers (`equipment.manage`) ──────────────────────
  // These hit the /api/equipment/* routes which accept a target
  // userId in the body. The audit actor remains the calling user so the
  // trail records who pulled the lever. checkout-for and return-for skip
  // the QR scan (a caller with `equipment.manage` is the override; the equipment's own qrSlug is
  // sent server-side to satisfy the verify check).
  async function reserveForOther(
    e: Equipment,
    userId: string,
    groupId?: string | null,
  ) {
    try {
      await apiPost(`/api/equipment/${e.id}/reserve-for`, {
        userId,
        ...(groupId ? { groupId } : {}),
      });
      notifyEquipmentUpdated();
      await load(false);
      const name = viewAsWorkerName(userId);
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
  async function cancelForOther(e: Equipment) {
    const uid = e.holder?.userId;
    if (!uid) return;
    try {
      await apiPost(`/api/equipment/${e.id}/reserve-for/cancel`, {
        userId: uid,
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Reservation canceled for ${viewAsWorkerName(uid)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Cancel on behalf failed.`, err),
      });
    }
  }
  async function checkoutForOther(e: Equipment) {
    const uid = e.holder?.userId;
    if (!uid) return;
    try {
      await apiPost(`/api/equipment/${e.id}/checkout-for/verify`, {
        userId: uid,
        slug: e.qrSlug,
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Checked out '${e.qrSlug}' for ${viewAsWorkerName(uid)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Checkout on behalf failed.`, err),
      });
    }
  }
  async function returnForOther(e: Equipment) {
    const uid = e.holder?.userId;
    if (!uid) return;
    try {
      await apiPost(`/api/equipment/${e.id}/return-for/verify`, {
        userId: uid,
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Returned '${e.qrSlug}' for ${viewAsWorkerName(uid)}.`,
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
          <Badge bg={groupName ? "purple.subtle" : "gray.subtle"}>{str}</Badge>
        </Box>
      );
    } else {
      return null;
    }
  }

  // ── Action-visibility helpers ───────────────────────────────────────
  // "Worker" actions (like/pin, reserve/cancel/checkout/return) fire on
  // behalf of a subject worker. Without view-as that subject is the
  // caller; with the view-as picker active it's the picked worker.
  // The helpers always compare against `subjectUserId` so the same
  // card affordances appear whether admin is looking at themselves or
  // impersonating.
  const subjectUserId = viewAsUserId ?? me?.id ?? null;
  // RESERVE ASKS FOR `inventory.pull`, WHICH IS NOT FIELD CLEARANCE.
  //
  // `POST /equipment/:id/reserve` is guarded on `inventory.pull`. This
  // screen gated the button on `work.claim` instead, and the starter roles
  // decouple the two on purpose: "May pull inventory" exists for "the
  // office person who fetches supplies but never runs a visit". That role
  // therefore got the Reserve button hidden AND was told it was a trainee,
  // while the endpoint would have accepted them. A UI gate has to name its
  // own endpoint's capability.
  const cannotPullInventory = !effScope.can("inventory.pull");

  const canSubjectCheckout = (e: Equipment) =>
    canViewEquipment && e.status === "RESERVED" && !!subjectUserId && e.holder?.userId === subjectUserId;
  const canSubjectCancel = (e: Equipment) =>
    canViewEquipment && e.status === "RESERVED" && !!subjectUserId && e.holder?.userId === subjectUserId;
  const canSubjectReturn = (e: Equipment) =>
    canViewEquipment && e.status === "CHECKED_OUT" && !!subjectUserId && e.holder?.userId === subjectUserId;
  const canSubjectReserve = (e: Equipment) =>
    canViewEquipment &&
    e.status === "AVAILABLE" &&
    // The field-clearance gate applies only to the ACTING caller. Somebody
    // viewing-as an uncleared person still holds their own clearance
    // underneath and may reserve on that person's behalf.
    (!!viewAsUserId || !cannotPullInventory);
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
    // subject of the reservation. Management view-as skips this — the
    // super endpoint on the server enforces the picked worker's
    // compliance, and dispatching the interceptor for the manager’s
    // own compliance would be nonsensical.
    if (equipmentPolicyIds.length > 0 && canViewEquipment && !viewAsUserId) {
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

  // The "act on behalf" buttons — hidden when the view-as
  // picker is active because the worker-tier buttons (rewired to route
  // through the same super endpoints under view-as) already cover the
  // same intent without the extra picker dialog.
  // `equipment.manage` — the guard on every on-behalf endpoint
  // (`reserve-for`, `reserve-for/cancel`, `checkout-for/verify`,
  // `return-for/verify`). It read `reports.view`, which is a reporting
  // grant and guards none of them: somebody with reporting but no
  // equipment authority was offered four buttons the server refuses,
  // and an equipment manager without reporting lost all four.
  const showActOnBehalfButtons = canManageEquipment && !viewAsUserId;
  const canReserveForOther = (e: Equipment) =>
    showActOnBehalfButtons && e.status === "AVAILABLE";
  const canCancelForOther = (e: Equipment) =>
    showActOnBehalfButtons && e.status === "RESERVED" && !!e.holder;
  const canCheckoutForOther = (e: Equipment) =>
    showActOnBehalfButtons && e.status === "RESERVED" && !!e.holder;
  const canReturnForOther = (e: Equipment) =>
    showActOnBehalfButtons && e.status === "CHECKED_OUT" && !!e.holder;

  const canForceRelease = (e: Equipment) => canManageEquipment && !!e.holder;
  const canStartMaintenance = (e: Equipment) =>
    canManageEquipment &&
    e.status !== "RETIRED" &&
    e.status !== "MAINTENANCE" &&
    !e.holder;
  const canEndMaintenance = (e: Equipment) =>
    canManageEquipment && e.status === "MAINTENANCE";
  const canRetire = (e: Equipment) =>
    canManageEquipment &&
    e.status !== "RETIRED" &&
    !e.holder &&
    e.status !== "RESERVED" &&
    e.status !== "CHECKED_OUT";
  const canUnretire = (e: Equipment) =>
    canManageEquipment && e.status === "RETIRED";
  // `equipment.capital`, matching `DELETE /equipment/:id`.
  //
  // It asked for `equipment.manage` and the comment claimed that matched
  // the route — true until 2026-10-22, when `equipment.manage` was split
  // and wiping a machine off the books went to `equipment.capital` with
  // the rest of the capital decisions. Left alone, an Admin would see a
  // Delete button that 403s: exactly the drift this comment has now been
  // wrong about twice (it previously said `equipment.manage` while the
  // code asked `reports.view`).
  //
  // Hidden outright rather than shown-but-disabled — a disabled control
  // with a hint was the confusing shape this replaced.
  const canDeleteFromBooks = effScope.can("equipment.capital");
  const canHardDelete = (e: Equipment) =>
    canDeleteFromBooks && e.status === "RETIRED";

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
                color="gray.fg"
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
                    <Text fontSize="xs" color="gray.fg" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Description:{" "}
                      </Text>
                      {item.longDesc}
                    </Text>
                  )}
                  {item.features && (
                    <Text fontSize="xs" color="gray.fg" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Features:{" "}
                      </Text>
                      {item.features}
                    </Text>
                  )}
                  {item.condition && (
                    <Text fontSize="xs" color="gray.fg" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Condition:{" "}
                      </Text>
                      {item.condition}
                    </Text>
                  )}
                  {item.issues && (
                    <Text fontSize="xs" color="gray.fg" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Issues:{" "}
                      </Text>
                      {item.issues}
                    </Text>
                  )}
                  {item.age && (
                    <Text fontSize="xs" color="gray.fg" mt={1}>
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

  // HOISTED ABOVE THE LOADING GATES ON PURPOSE.
  // The help panel is static copy — it does not depend on anything this tab
  // fetches. While it lived below the gates it was unmounted for the whole
  // fetch, and because the breadcrumb's (i) is driven by whichever explainer
  // is mounted, the icon blinked out and back on every visit to this tab.
  // Rendering it in the gate branches too keeps it mounted from the first
  // paint. Closed, it renders nothing, so the loading view is unchanged.
  const tabHelp = (
        <TabExplainer
          explainerId={`seedlings:inventoryTab:guideOpen:${canViewReports ? "super" : canManageEquipment ? "admin" : "worker"}`}
        >
          <ExplainerText>
            Every piece of equipment, what state it is in, who is holding it and which kits it
            belongs to. <Em>Reserve</Em> one to hold it, then scan its QR sticker to check it
            out; returning it is just a confirm, no scan needed. The scan button up top only
            finds a piece in the list — it does not claim it.
          </ExplainerText>
          <ExplainerText>
            Some pieces require a <Em>signed policy</Em> before anyone can take them out — if
            you have not signed it, Reserve opens that document before anything else.
          </ExplainerText>
          {!canManageEquipment && (
            cannotPullInventory ? (
              <ExplainerText>
                You can browse, pin and read up on anything, but{" "}
                <Em>reserving is off</Em> until someone grants you permission to take equipment
                out — until then, someone else checks it out to you. Nothing here is ever
                billed to you.
              </ExplainerText>
            ) : me?.workerType === "EMPLOYEE" ? (
              <ExplainerText>
                Your list puts pinned pieces first, then whatever you are holding, then what
                is available. Equipment is <Em>not billed to you</Em>; your cards read
                &ldquo;No charge&rdquo; because the business carries the cost of the tools you
                work with.
              </ExplainerText>
            ) : (
              <ExplainerText>
                Equipment you take out is billed to you: a card shows either a flat daily rate
                or a per-job rate capped at that daily figure, and the real charge is worked
                out <Em>when you return it</Em>, from the days you actually had it. If you
                lead a crew, the reserve picker lets you take a piece out for the crew — the
                cost then splits across the crew&rsquo;s contractors, and any employees or
                unpaid helpers in it pay nothing.
              </ExplainerText>
            )
          )}
          {canManageEquipment && (
            <CapabilitySection capability="equipment.manage" scope={scope}>
              <ExplainerText>
                You can edit a piece, <Em>force-release</Em> one a worker still has out, move
                it in and out of maintenance, and retire or un-retire it. Team Usage below is
                every worker&rsquo;s checkout history, grouped by person, piece, kit or day.
              </ExplainerText>
              <ExplainerText>
                There is no act-on-behalf button for you, but turning on <Em>view-as</Em> for
                a worker gives you their own reserve and return buttons when you need them.
                Adding a new piece and deleting a retired one need the same permission —
                putting equipment on the books is a capital decision.
              </ExplainerText>
            </CapabilitySection>
          )}
          {canViewReports && (
            <CapabilitySection capability="reports.view" scope={scope}>
              <ExplainerText>
                <Em>Adding a new piece</Em> and permanently deleting one that is already
                retired are yours alone.
              </ExplainerText>
              <ExplainerText>
                You can also reserve, check out or return <Em>on behalf of a worker</Em> — the
                QR scan is bypassed and the audit trail records that you pulled the lever, not
                them. Insights covers today&rsquo;s fleet state, rental income for the window,
                the leaderboard and what is sitting idle.
              </ExplainerText>
            </CapabilitySection>
          )}
        </TabExplainer>
  );

  if (!canViewEquipment) return <>{tabHelp}<UnavailableNotice /></>;
  if (!hasLoaded || (loading && items.length === 0)) return <>{tabHelp}<LoadingCenter /></>;

  return (
    <Box w="full">
      {/* Role-tailored orientation. Worker copy branches again on
          worker type because the money story is completely different
          per class: contractors are billed for what they take out,
          employees never are, and trainees cannot reserve at all
          (see canSubjectReserve + the workerRateBadge below). */}
        {tabHelp}
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
          css={{ background: "var(--chakra-colors-gray-subtle)" }}
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
          css={{ background: "var(--chakra-colors-gray-subtle)" }}
        >
          <ScanLine size={14} />
        </Button>
        {/* Create Equipment. Bringing new equipment onto the books is a
            capital-account decision, gated at both the UI (this branch)
            and the server (`equipment.manage` on POST /equipment).
            Editing + retiring existing pieces happens on the card
            action bands. */}
        {canViewReports && (
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
          leads at least one active group. Somebody who manages equipment
          and also leads a crew sees it too — the endpoint returns [] for
          anyone who leads no crew, so it is a natural no-op. Hidden while
          view-as is active, since group scope only applies to the person
          actually acting. */}
      {canViewEquipment && !viewAsUserId && groupsAsClaimer.length > 0 && (() => {
        const activeGroup = groupsAsClaimer.find((g) => g.id === reserveForGroupId);
        const isUnset = reserveForGroupId == null;
        const isSolo = reserveForGroupId === "";
        const isGroup = !!activeGroup;
        // Unselected state shouts louder than the made-a-choice states so
        // workers don't accidentally hit Reserve without picking a scope.
        const bg = isUnset ? "yellow.faint" : isGroup ? "purple.subtle" : "blue.faint";
        const borderColor = isUnset ? "yellow.strong" : isGroup ? "purple.strong" : "blue.emphasized";
        const headerColor = isUnset ? "yellow.fg" : isGroup ? "purple.fg" : "blue.fg";
        return (
          // `mt={3}` matches the `<Box mt={3}>` every section below this
          // uses, so the gap above the picker is the same as the gaps
          // between Insights, Team Usage and Collections. It had only a
          // bottom margin, so it sat tight under the toolbar.
          <Box mt={3} mb={3} p={3} bg={bg} borderWidth="2px" borderColor={borderColor} borderRadius="md">
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
              <Text fontSize="xs" color="purple.fg" mt={2}>
                Cost will be split among {activeGroup!.members.length + 1} workers on release.
              </Text>
            )}
            {isUnset && (
              <Text fontSize="xs" color="yellow.fg" mt={2}>
                You'll be asked to pick when you tap Reserve.
              </Text>
            )}
          </Box>
        );
      })()}
      {/* Insights (`reports.view`) — operations rollups only: today's
          fleet state, this-window checkouts + rental income + pieces
          used, the equipment leaderboard, and the idle list. The
          team-usage breakdown is a SEPARATE section below on
          `equipment.manage`, so somebody who runs the equipment gets the
          per-checkout detail without needing a reporting grant, and
          somebody with reporting gets the company metrics without being
          handed the raw logs. */}
      {/* `reports.business`, not `reports.view`: EquipmentInsightsSection
          reads GET /operations, which is the business-wide rollup. The
          team half of the old single entitlement stayed on `reports.view`
          when the two were split on 2026-10-23. */}
      {canViewBusinessReports && (
        /* Box carries the top margin — Dashboard styles its own frame and
           takes no layout props. A {JSX comment} here would be a second
           child of this parenthesised expression, which does not parse. */
        <Box mt={3}>
          <Dashboard
            storageKey={`seedlings:${pfx}:insightsOpen`}
            title="Insights"
            icon={BarChart3}
            variant="insights"
            // Header refresh, as on every other section. The section
            // already re-runs on an `inventory:refresh` event; this fires
            // the same one rather than inventing a second path.
            onRefresh={() => { window.dispatchEvent(new Event("inventory:refresh")); }}
          >
            <EquipmentInsightsSection />
          </Dashboard>
        </Box>
      )}
      {/* Admin+ team-usage section — the raw per-checkout log
          from the retired Usage tab, scoped to the whole team.
          Uses UsageBreakdown in SUPER mode (hits a caller with equipment authority
          `/api/equipment-usage` endpoint that returns every
          worker's checkouts) and unlocks the Person group-by. */}
      {canManageEquipment && (
        <Box mt={3} borderWidth="1px" borderColor="gray.emphasized" borderRadius="md" p={3}>
          <HStack
            gap={2}
            align="center"
            mb={teamUsageCollapsed ? 0 : 2}
            cursor="pointer"
            onClick={() => setTeamUsageCollapsed(!teamUsageCollapsed)}
            _hover={{ opacity: 0.7 }}
          >
            <Users size={14} color="var(--chakra-colors-gray-600)" />
            <Text fontSize="sm" fontWeight="bold" color="gray.fg" textTransform="uppercase" letterSpacing="wide">
              Team Usage
            </Text>
            <Text fontSize="xs" color="fg.muted">{teamUsageCollapsed ? "▶" : "▼"}</Text>
          </HStack>
          {!teamUsageCollapsed && <UsageBreakdown shows="team" />}
        </Box>
      )}
      {/* Personal usage — hidden for management since
          they get the fleet-wide Team Usage above (which surfaces
          the caller's own history alongside everyone else's under
          Person group-by). Collapsed by default. */}
      {canViewEquipment && !canManageEquipment && (
        <Box mt={3} borderWidth="1px" borderColor="gray.emphasized" borderRadius="md" p={3}>
          <HStack
            gap={2}
            align="center"
            mb={usageCollapsed ? 0 : 2}
            cursor="pointer"
            onClick={() => setUsageCollapsed(!usageCollapsed)}
            _hover={{ opacity: 0.7 }}
          >
            <User size={14} color="var(--chakra-colors-gray-600)" />
            <Text fontSize="sm" fontWeight="bold" color="gray.fg" textTransform="uppercase" letterSpacing="wide">
              Your Usage
            </Text>
            <Text fontSize="xs" color="fg.muted">{usageCollapsed ? "▶" : "▼"}</Text>
          </HStack>
          {!usageCollapsed && <UsageBreakdown shows="mine" />}
        </Box>
      )}
      {collections.length > 0 && (
        <Box mt={3} borderWidth="1px" borderColor="gray.emphasized" borderRadius="md" p={3}>
          <HStack gap={2} align="center" mb={collectionsCollapsed ? 0 : 2}>
            <HStack
              gap={2}
              align="center"
              cursor="pointer"
              onClick={() => setCollectionsCollapsed(!collectionsCollapsed)}
              _hover={{ opacity: 0.7 }}
            >
              <Package size={14} color="var(--chakra-colors-gray-600)" />
              <Text fontSize="sm" fontWeight="bold" color="gray.fg" textTransform="uppercase" letterSpacing="wide">Collections</Text>
              <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs">{collections.length}</Badge>
              <Text fontSize="xs" color="fg.muted">{collectionsCollapsed ? "▶" : "▼"}</Text>
            </HStack>
            {canManageEquipment && (
              <Badge
                size="sm"
                colorPalette="blue"
                variant="subtle"
                cursor="pointer"
                px="2"
                borderRadius="full"
                onClick={() => {
                  const evName = canViewReports ? "navigate:staffTab" : "navigate:staffTab";
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
                // Delegates to the module-level helper so a blank row reads
                // identically here and in the main list.
                const equipLabel = (eq: CollectionItem["equipment"]): string =>
                  equipmentLabel(eq);
                return (
                  <Card.Root
                    key={c.id}
                    variant="outline"
                    borderColor={highlightCollectionId === c.id ? "purple.500" : (allAvail ? "green.emphasized" : someAvail ? "yellow.emphasized" : "gray.emphasized")}
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
                          {/* SAME CAPABILITY AS THE PER-ITEM RESERVE.
                              This asked only for `equipment.view`, so the
                              whole kit grid offered Reserve to somebody who
                              cannot reserve a single piece. The server held
                              — every member came back 403 — but the button
                              fired one request per item and then reported
                              "nothing reserved" after the fact, which reads
                              as a system fault rather than a permission the
                              caller never had. `reserveKit` ends in the same
                              `POST /equipment/:id/reserve` (`inventory.pull`)
                              that the single-item button uses. */}
                          {canViewEquipment && !cannotPullInventory && (
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
                        <VStack align="stretch" gap={1.5} mt={2} pt={2} borderTopWidth="1px" borderColor="gray.emphasized">
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

      <Box position="relative" mt={3} borderWidth="1px" borderColor="gray.emphasized" borderRadius="md" p={3}>
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
        <Text fontSize="sm" fontWeight="bold" color="gray.fg" textTransform="uppercase" letterSpacing="wide">Equipment</Text>
        <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs">{filtered.length}</Badge>
        <Text fontSize="xs" color="fg.muted">{equipmentCollapsed ? "▶" : "▼"}</Text>
      </HStack>
      {!equipmentCollapsed && (
      <VStack align="stretch" gap={3}>
        {/* View-as picker — scopes ONLY the Equipment section
            (card actions + kit reserve). Insights / Team Usage /
            Collections list are fleet-wide regardless. Lives here
            inside the Equipment frame so it's obvious what it
            affects, not up at the tab level. */}
        {canManageEquipment && (
          <HStack gap={2} wrap="wrap" alignItems="center">
            <ViewAsSelector
              workers={viewAsWorkers as ViewAsWorker[]}
              selected={viewAsUserIds}
              // ViewAsSelector is multi-select — clicking a new
              // worker APPENDS to the array. Inventory only supports
              // one impersonation target at a time, so keep the
              // LAST clicked worker (slice(-1)), not the first —
              // otherwise re-opening the dropdown and picking a
              // different worker silently keeps the old one.
              onChange={(next) => setViewAsUserIds(next.slice(-1))}
            />
          </HStack>
        )}
        {canManageEquipment && viewAsUserIds.length > 0 && (
          <HStack gap={1} wrap="wrap" pl="1" alignItems="center">
            <Text fontSize="xs" color="fg.muted">Acting as:</Text>
            <ViewAsBadges workers={viewAsWorkers as ViewAsWorker[]} selected={viewAsUserIds} />
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
              background: !compact ? "var(--chakra-colors-gray-muted)" : "var(--chakra-colors-gray-subtle)",
              color: !compact ? "var(--chakra-colors-gray-fg)" : undefined,
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
              <Select.Trigger w="auto" minW="0" px="2" css={{ background: kind[0] !== "ALL" ? "var(--chakra-colors-blue-muted)" : "var(--chakra-colors-blue-subtle)", border: kind[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-strong)" : "1px solid var(--chakra-colors-blue-emphasized)", borderRadius: "6px" }}>
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
              <Select.Trigger w="auto" minW="0" px="2" css={{ background: statusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-muted)" : "var(--chakra-colors-purple-subtle)", border: statusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-strong)" : "1px solid var(--chakra-colors-purple-emphasized)", borderRadius: "6px" }}>
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
          {canViewEquipment && (
            <Button
              size="sm"
              variant={likedOnly ? "solid" : "outline"}
              px="2"
              flexShrink={0}
              onClick={() => setLikedOnly(!likedOnly)}
              css={likedOnly ? {
                background: "var(--chakra-colors-red-subtle)",
                color: "var(--chakra-colors-red-fg)",
                border: "1px solid var(--chakra-colors-red-strong)",
                "&:hover": { background: "var(--chakra-colors-red-muted)" },
              } : undefined}
              title="Show liked only"
            >
              <Heart size={14} fill={likedOnly ? "currentColor" : "none"} color="var(--chakra-colors-red-500)" />
            </Button>
          )}
        </HStack>
        {/* Active-filter chip row — reflects the toolbar's current
            state and offers a ✕ Clear to reset all filters at once. */}
        {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || (canViewEquipment && likedOnly) || (canManageEquipment && workerFilter.length > 0) || !!collectionFilter || highlightId) && (
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
            {!highlightId && canViewEquipment && likedOnly && (
              <Badge size="sm" colorPalette="red" variant="subtle">Liked</Badge>
            )}
            {!highlightId && canManageEquipment && workerFilter.map((id) => (
              <Badge key={id} size="sm" colorPalette="blue" variant="solid">
                {viewAsWorkerName(id)}
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
                if (canViewEquipment) setLikedOnly(false);
                if (canManageEquipment) setWorkerFilter([]);
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
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.emphasized" />
                <HStack gap={1.5} align="center">
                  <Text fontSize="sm" fontWeight="bold" color="gray.fg" whiteSpace="nowrap" textTransform="uppercase" letterSpacing="wide">
                    {group.label}
                  </Text>
                  <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs" lineHeight="1">
                    {group.items.length}
                  </Badge>
                  <Text fontSize="xs" color="fg.muted">{collapsedGroups.has(group.key) ? "▶" : "▼"}</Text>
                </HStack>
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.emphasized" />
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
                    <HStack key={inst.id} gap="1.5" px="2" py="1" bg="yellow.subtle" borderWidth="1px" borderColor="yellow.strong" borderRadius="md">
                      <AlertCircle
                        size={18}
                        color="var(--chakra-colors-yellow-900)"
                        fill="var(--chakra-colors-yellow-400)"
                        strokeWidth={2.5}
                      />
                      <Text fontSize="xs" fontWeight="semibold" color="yellow.fg">{inst.text}</Text>
                    </HStack>
                  ))}
                </Box>
              ) : (
                <Box mx="3" mt="2" mb="0" px="3" py="1.5" bg="yellow.subtle" borderWidth="1px" borderColor="yellow.strong" borderRadius="md">
                  <VStack align="stretch" gap="0.5">
                    {(e.instructions ?? []).map((inst) => (
                      <HStack key={inst.id} gap="1.5" align="center">
                        <AlertCircle
                          size={18}
                          color="var(--chakra-colors-yellow-900)"
                          fill="var(--chakra-colors-yellow-400)"
                          strokeWidth={2.5}
                        />
                        <Text fontSize="xs" fontWeight="semibold" color="yellow.fg">
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
                        if (canSubjectReserve(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="green.400" color="green.fg" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "green.500" }} title="Reserve" onClick={(ev: any) => {
                              ev.stopPropagation();
                              void openReserveConfirm(e);
                            }}><Hand size={12} /></Box>
                          );
                        }
                        if (canSubjectCheckout(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="blue.solid" color="blue.contrast" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "blue.600" }} title="Check Out" onClick={(ev: any) => {
                              ev.stopPropagation();
                              setScanFor(e.id);
                            }}><ScanLine size={12} /></Box>
                          );
                        }
                        if (canSubjectReturn(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="orange.solid" color="orange.contrast" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "orange.600" }} title="Return" onClick={(ev: any) => {
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
                        title={equipmentLabel(e)}
                      >{equipmentLabel(e)}</Text>
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
                      const palette = wt === "EMPLOYEE" ? "blue" : wt === "UNPAID" ? "purple" : "orange";
                      // A contractor's pill comes from the SAME resolved
                      // billing mode the full card and the reserve dialog
                      // use — never from the raw dailyRate. Reading the
                      // column directly ignored both the
                      // EQUIPMENT_BILLING_ENABLED master toggle (compact
                      // said "$4.00/day" while the full card said
                      // "$0.00/day") and per-job billing (it showed the
                      // daily cap as if it were a flat daily rate).
                      // Employees and trainees are never billed, so they
                      // keep reading "No charge" regardless of the chip.
                      const isBillable = isFeeable(wt);
                      const workerPill = canViewEquipment
                        ? isBillable && chip
                          ? <Badge key="w" colorPalette={palette} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">{chip}</Badge>
                          : <Badge key="w" colorPalette={palette} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                        : null;
                      const elevatedPill = canManageEquipment && chip
                        ? <Badge key="a" colorPalette="orange" variant="subtle" fontSize="xs" px="1.5" borderRadius="full" title="Contractor billing">{chip}</Badge>
                        : null;
                      return <>{workerPill}{elevatedPill}</>;
                    })()}
                  </HStack>
                </VStack>
              </HStack>
            ) : (
            <>
            <Card.Header py="2" px="3" pb="0">
              <HStack justify="space-between" alignItems="flex-start" gap={2}>
              <Box display="flex" flexDirection="column" gap={1} flex="1" minW={0}>
                <Text fontSize="md" fontWeight="semibold">{equipmentLabel(e)}</Text>
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
                  <EquipmentPhotos equipmentId={e.id} scope={scope} hasPhotos={e.hasPhotos} />
                </Box>
                {e.qrSlug && (
                  <HStack gap={1} mt={0} align="center">
                    <Text fontSize="xs" color="gray.fg">
                      <Text as="span" fontWeight="bold">
                        ID:{" "}
                      </Text>
                      {e.qrSlug}
                    </Text>
                    <Box
                      as="button"
                      flexShrink={0}
                      color="fg.muted"
                      _hover={{ color: "blue.fg" }}
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
                  <Text fontSize="xs" color="gray.fg" mt={0}>
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
                  //    the daily rate, a W-2 employee sees "No charge".
                  //  • Admin row (when scope includes admin) — shows
                  //    the CONTRACTOR + EMPLOYEE billing rules for the
                  //    equipment itself, so holders of `equipment.manage` can audit the
                  //    rate/cap config at a glance.
                  //
                  // Each row is prefixed with a small role label so a
                  // super sees both without confusion. The role label
                  // pattern mirrors the ElevatedActionRow footer bands.
                  const mode = resolveBillingMode(e.dailyRate, e.equivalentJobs, equipmentBillingEnabled);
                  const chip = shortBillingChip(mode);
                  const wt = me?.workerType;
                  const workerRateBadge = (() => {
                    if (wt === "UNPAID") return (
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
                        <Text fontSize="xs" color="orange.fg">rental cost</Text>
                      </>
                    ) : (
                      <Text fontSize="xs" color="orange.fg">No rental cost</Text>
                    );
                  })();
                  return (
                    <VStack align="start" gap={1} mt={0.5} fontSize="xs">
                      {canViewEquipment && (
                        <HStack gap={2}>
                          <Badge size="xs" variant="subtle" colorPalette="blue">You</Badge>
                          {workerRateBadge}
                        </HStack>
                      )}
                      {canManageEquipment && (
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
                canViewEquipment={canViewEquipment}
                canManageEquipment={canManageEquipment}
                cannotPullInventory={cannotPullInventory}
                viewAsUserId={viewAsUserId}
                viewAsUserName={viewAsUserId ? viewAsWorkerName(viewAsUserId) : null}
                canSubjectCheckout={canSubjectCheckout(e)}
                canSubjectCancel={canSubjectCancel(e)}
                canSubjectReturn={canSubjectReturn(e)}
                canSubjectReserve={canSubjectReserve(e)}
                canForceRelease={canForceRelease(e)}
                canStartMaintenance={canStartMaintenance(e)}
                canEndMaintenance={canEndMaintenance(e)}
                canRetire={canRetire(e)}
                canUnretire={canUnretire(e)}
                canHardDelete={canHardDelete(e)}
                canReserveForOther={canReserveForOther(e)}
                canCancelForOther={canCancelForOther(e)}
                canCheckoutForOther={canCheckoutForOther(e)}
                canReturnForOther={canReturnForOther(e)}
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
                    summary: equipmentLabel(e),
                    extra: e.qrSlug ?? undefined,
                  })
                }
                onReserveForOther={() => {
                  setOnBehalfUserId("");
                  setActOnBehalfFor({ equipment: e, action: "reserve" });
                }}
                onCancelForOther={() => setActOnBehalfFor({ equipment: e, action: "cancel" })}
                onCheckoutForOther={() => setActOnBehalfFor({ equipment: e, action: "checkout" })}
                onReturnForOther={() => setActOnBehalfFor({ equipment: e, action: "return" })}
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
            ? `Check in "${equipmentLabel(returnConfirmEquip)}" and make it available again.`
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
            <Box borderWidth="1px" borderColor="green.emphasized" borderRadius="md" bg="green.faint" px={2} py={1.5}>
              <Text fontSize="xs" color="green.fg" fontWeight="semibold" mb={1}>
                Will reserve ({kitPartialConfirm.available.length})
              </Text>
              <VStack align="stretch" gap={0.5}>
                {kitPartialConfirm.available.map((it) => (
                  <Text key={it.id} fontSize="xs" color="green.fg">
                    • {equipmentLabel({ ...it.equipment, id: it.equipment.id ?? it.equipmentId })}
                  </Text>
                ))}
              </VStack>
            </Box>
            <Box borderWidth="1px" borderColor="yellow.emphasized" borderRadius="md" bg="yellow.faint" px={2} py={1.5}>
              <Text fontSize="xs" color="yellow.fg" fontWeight="semibold" mb={1}>
                Will skip ({kitPartialConfirm.unavailable.length})
              </Text>
              <VStack align="stretch" gap={0.5}>
                {kitPartialConfirm.unavailable.map((u) => (
                  <HStack key={u.item.id} gap={2} justify="space-between">
                    <Text fontSize="xs" color="yellow.fg">
                      • {equipmentLabel({ ...u.item.equipment, id: u.item.equipment.id ?? u.item.equipmentId })}
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
      {canManageEquipment && (
        <EquipmentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          scope={effScope}
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {canDeleteFromBooks && (
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
                    <Box p={3} bg="gray.faint" rounded="md" borderWidth="1px" borderColor="gray.emphasized">
                      <Text fontSize="sm" fontWeight="medium">{equipmentLabel(reserveConfirmEquip)}</Text>
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
                            <Box mt={1} p={2} bg="orange.faint" rounded="md" borderWidth="1px" borderColor="orange.emphasized">
                              <Text fontSize="sm" color="orange.fg" fontWeight="semibold">
                                Rental charge: {shortBillingChip(mode)}
                              </Text>
                              <Text fontSize="xs" color="orange.fg" mt={0.5}>
                                {instructiveBillingText(mode)}
                              </Text>
                            </Box>
                          );
                        }
                        return (
                          <Box mt={1} p={2} bg="green.faint" rounded="md">
                            <Text fontSize="xs" color="green.fg" fontWeight="medium">
                              {wt === "EMPLOYEE" ? "No charge  — equipment covered for employees"
                                : wt === "UNPAID" ? "No charge — equipment is never billed to unpaid helpers"
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

      {/* "Act on behalf" dialog (`equipment.manage`). Reserve picks a worker
          from the workers list; the other three actions imply the current
          holder. checkout-for and return-for skip the QR scan since the
          `equipment.manage` is the override path. */}
      <Dialog.Root
        open={!!actOnBehalfFor}
        onOpenChange={(e) => {
          if (!e.open) {
            setActOnBehalfFor(null);
            setOnBehalfUserId("");
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
                  {actOnBehalfFor?.action === "reserve" && "Reserve on behalf of a worker"}
                  {actOnBehalfFor?.action === "cancel" && "Cancel reservation on behalf"}
                  {actOnBehalfFor?.action === "checkout" && "Check out on behalf"}
                  {actOnBehalfFor?.action === "return" && "Return on behalf"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {/* Surface the impersonation warning once a worker is
                    selected — every action in this dialog ("on behalf
                    of") is someone with equipment authority acting on someone else's equipment
                    record. Until they pick, no warning (action is not
                    yet associated with anyone). The role-impersonation
                    side of the banner still fires when applicable. */}
                <ImpersonationWarning
                  viewAsName={
                    onBehalfUserId
                      ? (viewAsWorkers.find((w) => w.id === onBehalfUserId)?.displayName
                          ?? viewAsWorkers.find((w) => w.id === onBehalfUserId)?.email
                          ?? null)
                      : null
                  }
                />
                {actOnBehalfFor && (
                  <VStack align="stretch" gap={3}>
                    <Box p={3} bg="gray.faint" rounded="md" borderWidth="1px" borderColor="gray.emphasized">
                      <Text fontSize="sm" fontWeight="medium">
                        {equipmentLabel(actOnBehalfFor.equipment)}
                      </Text>
                      {(actOnBehalfFor.equipment.brand || actOnBehalfFor.equipment.model) && (
                        <Text fontSize="xs" color="fg.muted">
                          {[actOnBehalfFor.equipment.brand, actOnBehalfFor.equipment.model]
                            .filter(Boolean)
                            .join(" ")}
                        </Text>
                      )}
                      <Text fontSize="xs" color="fg.muted" mt={1}>
                        QR: {actOnBehalfFor.equipment.qrSlug}
                      </Text>
                    </Box>

                    {actOnBehalfFor.action === "reserve" ? (
                      <>
                        <Text fontSize="sm" color="fg.muted">
                          Pick the worker this reservation should be recorded for. The audit trail will show you as a caller with equipment authority who performed the action.
                        </Text>
                        <Box>
                          <Text fontSize="xs" fontWeight="semibold" mb={1}>Worker</Text>
                          <Select.Root
                            collection={workerCollection}
                            value={onBehalfUserId ? [onBehalfUserId] : []}
                            onValueChange={(e) => setOnBehalfUserId(e.value[0] ?? "")}
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
                                {workerItems.map((it) => (
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
                      <Box p={2} bg="purple.faint" rounded="md" borderWidth="1px" borderColor="purple.emphasized">
                        <Text fontSize="sm" color="purple.fg">
                          {actOnBehalfFor.action === "cancel" && "Cancel "}
                          {actOnBehalfFor.action === "checkout" && "Check out "}
                          {actOnBehalfFor.action === "return" && "Return "}
                          on behalf of{" "}
                          <Text as="span" fontWeight="semibold">
                            {actOnBehalfFor.equipment.holder?.displayName ||
                              actOnBehalfFor.equipment.holder?.email ||
                              "the current holder"}
                          </Text>
                          .
                        </Text>
                        {actOnBehalfFor.action === "checkout" && (
                          <Text fontSize="xs" color="purple.fg" mt={1}>
                            QR scan is bypassed — `equipment.manage` override.
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
                      setActOnBehalfFor(null);
                      setOnBehalfUserId("");
                    }}
                    disabled={onBehalfBusy}
                  >
                    Cancel
                  </Button>
                  <Button
                    colorPalette="purple"
                    loading={onBehalfBusy}
                    disabled={
                      actOnBehalfFor?.action === "reserve" && !onBehalfUserId
                    }
                    onClick={async () => {
                      if (!actOnBehalfFor) return;
                      setOnBehalfBusy(true);
                      try {
                        const { equipment, action } = actOnBehalfFor;
                        if (action === "reserve") {
                          await reserveForOther(equipment, onBehalfUserId);
                        } else if (action === "cancel") {
                          await cancelForOther(equipment);
                        } else if (action === "checkout") {
                          await checkoutForOther(equipment);
                        } else if (action === "return") {
                          await returnForOther(equipment);
                        }
                      } finally {
                        setOnBehalfBusy(false);
                        setActOnBehalfFor(null);
                        setOnBehalfUserId("");
                      }
                    }}
                  >
                    {actOnBehalfFor?.action === "reserve" && "Reserve"}
                    {actOnBehalfFor?.action === "cancel" && "Cancel reservation"}
                    {actOnBehalfFor?.action === "checkout" && "Check out"}
                    {actOnBehalfFor?.action === "return" && "Return"}
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
// Sourced from /api/operations (same endpoint the header
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
        items: FULL_PERIODS.map((p) => ({ label: p.label, value: periodKey(p) })),
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
        const res = await apiGet<InsightsResponse>(`/api/operations?${qs}`);
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
                  const next = FULL_PERIODS.find((p) => periodKey(p) === k);
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
                <InsightsMetric label="Checkouts" value={String(data.windowCheckouts)} color="blue.fg" />
                <InsightsMetric label="Rental Income" value={fmtMoney(data.windowIncome)} color="green.fg" />
                <InsightsMetric label="Pieces Used" value={`${data.windowDistinctUsed} / ${data.total}`} color="gray.fg" />
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
                          {equipmentLabel(e)}
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
    .map((e) => ({ name: equipmentLabel(e), value: activeMetric.getter(e) }))
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
        <HStack gap={0} borderWidth="1px" borderColor="gray.emphasized" borderRadius="md" overflow="hidden" flexShrink={0}>
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
            <HStack px={3} py={1} borderBottomWidth="1px" borderColor="gray.emphasized" fontSize="xs" fontWeight="semibold" color="fg.muted" gap={2}>
              <Text flex="1" minW={0}>Equipment</Text>
              <Text w="55px" textAlign="right">Days</Text>
              <Text w="50px" textAlign="right" display={{ base: "none", sm: "block" }} title="Number of billed jobs across the window (per-job billing)">Jobs</Text>
              <Text w="55px" textAlign="right">Rentals</Text>
              <Text w="70px" textAlign="right" display={{ base: "none", md: "block" }}>Income</Text>
              <Text w="55px" textAlign="right">Util %</Text>
            </HStack>
            {leaderboard.map((e) => (
              <HStack key={e.id} px={3} py={1.5} borderBottomWidth="1px" borderColor="gray.faint" fontSize="xs" gap={2}
                _hover={{ bg: "gray.faint" }}
              >
                <VStack align="start" gap={0} flex="1" minW={0}>
                  <Text fontWeight="medium" truncate>{equipmentLabel(e)}</Text>
                  {(e.brand || e.model) && (
                    <Text color="fg.muted" fontSize="2xs" truncate>
                      {[e.brand, e.model].filter(Boolean).join(" ")}
                    </Text>
                  )}
                </VStack>
                <Text w="55px" textAlign="right" color="blue.fg" fontWeight="medium">{e.daysOut}</Text>
                <Text w="50px" textAlign="right" color="teal.fg" display={{ base: "none", sm: "block" }}>
                  {e.jobsBilled != null ? e.jobsBilled : "—"}
                </Text>
                <Text w="55px" textAlign="right" color="fg.muted">{e.checkouts}</Text>
                <Text w="70px" textAlign="right" color="green.fg" display={{ base: "none", md: "block" }}>{fmtMoney(e.income)}</Text>
                <Text w="55px" textAlign="right" color={e.utilizationPct >= 50 ? "green.fg" : e.utilizationPct > 0 ? "orange.fg" : "fg.muted"}>{e.utilizationPct}%</Text>
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
// Renders a summary strip + a group-by picker (equipment / collection /
// day, plus Person when the caller may see other people's) + expandable
// checkout rows. Both scopes read /api/equipment-usage; the server decides
// how much comes back. Uses its own persisted date range + group-by state
// so the mount site does not have to thread props through.

/** WHOSE usage this breakdown shows — a DATA SCOPE, not an authority. */
type UsageScope = "mine" | "team";
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

// Delegates: this was a third copy of the same fallback chain living a
// few thousand lines from the others, so a blank row read differently
// depending on which panel you were looking at.
function usageEquipmentLabel(e: UsageRow["equipment"]): string {
  return equipmentLabel(e);
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

function UsageBreakdown({ shows }: { shows: UsageScope }) {
  const isTeam = shows === "team";
  const pfx = `usage_${shows}`;
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [collections, setCollections] = useState<UsageCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = usePersistedState<UsagePreset>(`${pfx}_preset`, "30");
  const [groupBy, setGroupBy] = usePersistedState<UsageGroupBy>(
    `${pfx}_groupBy`,
    isTeam ? "person" : "equipment",
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
        const base = isTeam ? "/api/equipment-usage" : "/api/equipment-usage";
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
  }, [preset, isTeam, refreshTick]);

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

  const groupModes: { key: UsageGroupBy; label: string }[] = isTeam
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
                          if (isTeam && groupBy !== "person") ctx.push(usagePersonLabel(r.user));
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
        <Text fontSize="xl" fontWeight="bold" color={props.colorPalette ? `${props.colorPalette}.fg` : undefined}>
          {props.value}
        </Text>
        <Text fontSize="xs" color="fg.muted">{props.label}</Text>
      </Card.Body>
    </Card.Root>
  );
}
