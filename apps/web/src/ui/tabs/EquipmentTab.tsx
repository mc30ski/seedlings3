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
  Portal,
  Text,
  VStack,
  Select,
  Spinner,
  createListCollection,
  useDisclosure,
} from "@chakra-ui/react";
import { AlertTriangle, Filter, Hand, Heart, LayoutList, List, Maximize2, MoreHorizontal, Pin, Plus, RefreshCw, RotateCcw, ScanLine, Share2, X } from "lucide-react";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import {
  determineRoles,
  prettyStatus,
  notifyEquipmentUpdated,
  extractSlug,
  equipmentStatusColor,
} from "@/src/lib/lib";
import { TabPropsType, EquipmentStatus, Equipment } from "@/src/lib/types";
import { onEventSearchRun } from "@/src/lib/bus";
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

import { EQUIPMENT_KIND, EQUIPMENT_STATUS } from "@/src/lib/types";
import { parseEquipmentKindsConfig, type EquipmentKindConfig } from "@/src/lib/equipmentSuggestions";

// Kind states are now derived from loaded items (see useMemo below)

// Constant representing the status states for this entity.
const workerStatusStates = [
  "ALL",
  "CLAIMED",
  "AVAILABLE",
  "UNAVAILABLE",
] as const;
const adminStatusStates = ["ALL", ...EQUIPMENT_STATUS] as const;

export default function EquipmenTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isSuper, isAvail, forAdmin } = determineRoles(me, purpose);

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const pfx = purpose === "WORKER" ? "equip_w" : "equip_a";
  const [compact, setCompact] = usePersistedState(`${pfx}_compact`, false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(
    `${pfx}_status`, purpose === "WORKER" ? ["CLAIMED"] : ["ALL"]
  );
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);
  const [likedOnly, setLikedOnly] = usePersistedState<boolean>(`${pfx}_likedOnly`, false);

  const isWorkerView = purpose === "WORKER";
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Equipment[]>([]);
  const [equipmentKinds, setEquipmentKinds] = useState<EquipmentKindConfig[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [scanReturnFor, setScanReturnFor] = useState<string | null>(null);
  const [reserveConfirmEquip, setReserveConfirmEquip] = useState<Equipment | null>(null);
  const [reserveChecked, setReserveChecked] = useState(false);
  const [qrAction, setQrAction] = useState<{ equipmentId: string; slug: string; action: "checkout" | "return"; label: string } | null>(null);
  const [qrActionBusy, setQrActionBusy] = useState(false);

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

  // Loads all the items for the first time.
  useEffect(() => {
    void load();
    const settingsPath = forAdmin ? "/api/admin/settings" : "/api/settings";
    apiGet<any[]>(settingsPath)
      .then((list) => {
        if (!Array.isArray(list)) return;
        const ek = list.find((r: any) => r.key === "EQUIPMENT_KINDS");
        if (ek?.value) { const parsed = parseEquipmentKindsConfig(ek.value); if (parsed) setEquipmentKinds(parsed); }
      })
      .catch(() => {});
  }, [forAdmin]);

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

  // Check for pending equipment kind filter (set by suggested equipment chips on Jobs/Services tabs)
  useEffect(() => {
    const kindOverride = window.sessionStorage.getItem("equipmentKindFilter");
    if (kindOverride) {
      setKind([kindOverride]);
      setQ("");
      window.sessionStorage.removeItem("equipmentKindFilter");
    }
  });

  // Handle QR slug redirect (from /e/[slug] page)
  // Wait for items to load, then find equipment by slug and prompt checkout/return
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

    return rows;
  }, [items, q, kind, statusFilter, forAdmin, isWorkerView, likedOnly, likedIds, highlightId]);

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
      await apiPost(`/api/equipment/${id}/checkout/verify`, {
        slug: extractSlug(slug),
      });
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
  async function returnVerifiedWithSlug(id: string, slug: string) {
    try {
      await apiPost(`/api/equipment/${id}/return/verify`, {
        slug: extractSlug(slug),
      });
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${slug}' successfully returned.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${slug}' return failed.`, err),
      });
    }
  }
  async function reserve(e: Equipment) {
    try {
      await apiPost(`/api/equipment/${e.id}/reserve`);
      notifyEquipmentUpdated();
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Equipment '${e.qrSlug}' successfully reserved.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Equipment '${e.qrSlug}' reserved failed.`, err),
      });
    }
  }
  async function cancel(e: Equipment) {
    try {
      await apiPost(`/api/equipment/${e.id}/reserve/cancel`);
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

  function unavailableMessage(item: Equipment) {
    if (
      item.holder?.state === "CHECKED_OUT" ||
      item.holder?.state === "RESERVED"
    ) {
      let str =
        item.holder.state === "CHECKED_OUT"
          ? "Checked out by "
          : "Reserved by ";
      str +=
        item.holder?.displayName ||
        item.holder?.email ||
        item.holder?.userId.slice(0, 8);

      return (
        <Box pt="2">
          <Badge bg="gray.100">{str}</Badge>
        </Box>
      );
    } else {
      return null;
    }
  }

  const canWorkerCheckout = (e: Equipment) =>
    purpose === "WORKER" && e.status === "RESERVED" && !!me && e.holder?.userId === me.id;
  const canWorkerCancel = (e: Equipment) =>
    purpose === "WORKER" && e.status === "RESERVED" && !!me && e.holder?.userId === me.id;
  const canWorkerReturn = (e: Equipment) =>
    purpose === "WORKER" && e.status === "CHECKED_OUT" && !!me && e.holder?.userId === me.id;
  const isTrainee = me?.workerType === "TRAINEE";
  const canWorkerReserve = (e: Equipment) =>
    purpose === "WORKER" &&
    e.status === "AVAILABLE" &&
    !isTrainee &&
    (!e.requiresInsurance || me?.isInsuranceValid || me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE");

  const canAdminForceRelease = (e: Equipment) =>
    purpose === "ADMIN" && !!e.holder;
  const canAdminStartMaintenance = (e: Equipment) =>
    purpose === "ADMIN" &&
    e.status !== "RETIRED" &&
    e.status !== "MAINTENANCE" &&
    !e.holder;
  const canAdminEndMaintenance = (e: Equipment) =>
    purpose === "ADMIN" && e.status === "MAINTENANCE";
  const canAdminRetire = (e: Equipment) =>
    purpose === "ADMIN" &&
    e.status !== "RETIRED" &&
    !e.holder &&
    e.status !== "RESERVED" &&
    e.status !== "CHECKED_OUT";
  const canAdminUnretire = (e: Equipment) =>
    purpose === "ADMIN" && e.status === "RETIRED";
  const canAdminHardDelete = (e: Equipment) =>
    purpose === "ADMIN" && e.status === "RETIRED";

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
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)" }}>
          <RefreshCw size={14} />
        </Button>
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
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={setQ}
          inputId="equipment-search"
          placeholder="Search…"
        />
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
            title={`Show liked only (${likedIds.size})`}
          >
            <Heart size={14} fill={likedOnly ? "currentColor" : "none"} color="var(--chakra-colors-red-500)" />
            {likedIds.size > 0 && (
              <Badge
                size="xs"
                colorPalette="red"
                variant="solid"
                borderRadius="full"
                px="1.5"
                fontSize="2xs"
                lineHeight="1"
                minW="0"
              >
                {likedIds.size}
              </Badge>
            )}
          </Button>
        )}
        {forAdmin && (
          <Button
            variant="solid"
            size="sm"
            px="2"
            minW="0"
            onClick={openCreate}
            bg="black"
            color="white"
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || (isWorkerView && likedOnly) || highlightId) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
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
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => {
              setHighlightId(null);
              setKind(["ALL"]);
              setStatusFilter(["ALL"]);
              if (isWorkerView) setLikedOnly(false);
            }}
          >
            ✕ Clear
          </Badge>
        </HStack>
      )}
      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      <VStack align="stretch" gap={3}>
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
            {isCardCompact && !forAdmin ? (
              <HStack align="center" gap={3} py="2" px="3">
                <EquipmentThumbnail equipmentId={e.id} hasPhotos={e.hasPhotos} />
                <VStack align="stretch" gap={1} flex="1" minW={0}>
                  <HStack justify="space-between" alignItems="flex-start" gap={2}>
                  <Box display="flex" flexDirection="column" gap={1} flex="1" minW={0}>
                    <HStack gap={2} alignItems="center" minW={0}>
                      {(() => {
                        if (canWorkerReserve(e)) {
                          return (
                            <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="yellow.400" color="yellow.900" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "yellow.500" }} title="Reserve" onClick={(ev: any) => {
                              ev.stopPropagation();
                              setReserveConfirmEquip(e);
                              setReserveChecked(false);
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
                              setScanReturnFor(e.id);
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
                      {e.requiresInsurance && (
                        <Box as="span" display="inline-flex" alignItems="center" title="Valid insurance required to reserve this equipment">
                          <StatusBadge status="Insured" palette="yellow" variant="subtle" />
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
                      const wt = me?.workerType;
                      const palette = wt === "EMPLOYEE" ? "blue" : wt === "TRAINEE" ? "green" : "orange";
                      const rate = wt === "EMPLOYEE" ? e.employeeDailyRate
                        : wt === "TRAINEE" ? null
                        : e.dailyRate;
                      if (rate != null && rate > 0) {
                        return (
                          <Badge colorPalette={palette} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                            ${rate.toFixed(2)}/day
                          </Badge>
                        );
                      }
                      return (
                        <Badge colorPalette={palette} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                          No charge
                        </Badge>
                      );
                    })()}
                  </HStack>
                </VStack>
              </HStack>
            ) : (
            <>
            <Card.Header py="2" px="3" pb="0">
              <HStack justify="space-between" alignItems="flex-start" gap={2}>
              <Box display="flex" flexDirection="column" gap={1} flex="1" minW={0}>
                <Text
                  fontSize={isCardCompact ? "sm" : "md"}
                  fontWeight="semibold"
                  whiteSpace={isCardCompact ? "nowrap" : undefined}
                  overflow={isCardCompact ? "hidden" : undefined}
                  textOverflow={isCardCompact ? "ellipsis" : undefined}
                  title={isCardCompact ? e.shortDesc : undefined}
                >{e.shortDesc}</Text>
                <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" flexShrink={0} mb={1}>
                  <StatusBadge
                    status={e.status ?? ""}
                    palette={equipmentStatusColor(e.status ?? "")}
                    variant="subtle"
                  />
                  <StatusBadge status={e.type} palette="gray" variant="outline" />
                  {e.requiresInsurance && (
                    <Box as="span" display="inline-flex" alignItems="center" title="Valid insurance required to reserve this equipment">
                      <StatusBadge status="Insured" palette="yellow" variant="subtle" />
                    </Box>
                  )}
                </Box>
              </Box>
              <ActionIcons equipmentId={e.id} />
              </HStack>
            </Card.Header>
            {isCardCompact ? (
              <Card.Body py="2" px="3" pt="0">
                <HStack gap={2} fontSize="xs" color="fg.muted">
                  <Text>
                    {e.brand ? `${e.brand} ` : ""}
                    {e.model ? `${e.model} ` : ""}
                  </Text>
                  {forAdmin && (
                    <HStack gap={1}>
                      {e.dailyRate != null && e.dailyRate > 0 && (
                        <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="1.5" borderRadius="full" title="Contractor rate">
                          ${e.dailyRate.toFixed(2)}/day
                        </Badge>
                      )}
                      {e.employeeDailyRate != null && e.employeeDailyRate > 0 && (
                        <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="1.5" borderRadius="full" title="Employee rate">
                          ${e.employeeDailyRate.toFixed(2)}/day
                        </Badge>
                      )}
                    </HStack>
                  )}
                </HStack>
              </Card.Body>
            ) : (
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
                  <Text fontSize="xs" color="gray.500" mt={0}>
                    <Text as="span" fontWeight="bold">
                      ID:{" "}
                    </Text>
                    {e.qrSlug}
                  </Text>
                )}
                {e.energy && (
                  <Text fontSize="xs" color="gray.500" mt={0}>
                    <Text as="span" fontWeight="bold">
                      Power:{" "}
                    </Text>
                    {e.energy}
                  </Text>
                )}
                {forAdmin ? (
                  <VStack align="start" gap={1} mt={0.5} fontSize="xs">
                    <HStack gap={2}>
                      <Text color="fg.muted">Contractor:</Text>
                      {e.dailyRate != null && e.dailyRate > 0 ? (
                        <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                          ${e.dailyRate.toFixed(2)}/day
                        </Badge>
                      ) : (
                        <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                      )}
                    </HStack>
                    <HStack gap={2}>
                      <Text color="fg.muted">Employee:</Text>
                      {e.employeeDailyRate != null && e.employeeDailyRate > 0 ? (
                        <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                          ${e.employeeDailyRate.toFixed(2)}/day
                        </Badge>
                      ) : (
                        <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                      )}
                    </HStack>
                  </VStack>
                ) : me?.workerType === "TRAINEE" ? (
                  <HStack gap={2} mt={0.5} wrap="wrap">
                    <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                      No charge — trainees cannot reserve equipment
                    </Badge>
                  </HStack>
                ) : me?.workerType === "EMPLOYEE" ? (
                  e.employeeDailyRate != null && e.employeeDailyRate > 0 ? (
                    <HStack gap={2} mt={0.5}>
                      <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        ${e.employeeDailyRate.toFixed(2)}/day
                      </Badge>
                      <Text fontSize="xs" color="blue.500">rental cost</Text>
                    </HStack>
                  ) : (
                    <Text fontSize="xs" color="blue.500" mt={0.5}>No rental cost</Text>
                  )
                ) : e.dailyRate != null && e.dailyRate > 0 ? (
                  <HStack gap={2} mt={0.5}>
                    <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                      ${e.dailyRate.toFixed(2)}/day
                    </Badge>
                    <Text fontSize="xs" color="orange.500">rental cost</Text>
                  </HStack>
                ) : (
                  <Text fontSize="xs" color="orange.500" mt={0.5}>No rental cost</Text>
                )}
                {/* Minimal collapsible for details */}
                <ItemTile item={e} isMine={isMine(e)} />
                {unavailableMessage(e)}
              </VStack>
            </Card.Body>
            )}
            {!isCardCompact && (
            <Card.Footer py="2" px="3" pt="0">
              <HStack gap={2} wrap="wrap">
                {forAdmin && (
                  <StatusButton
                    id={"equipment-edit"}
                    itemId={e.id}
                    label={"Edit"}
                    onClick={async () => {
                      await openEdit(e);
                    }}
                    variant={"outline"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canWorkerCheckout(e) && (
                  <StatusButton
                    id={"equipment-checkout"}
                    itemId={e.id}
                    label={"Check Out"}
                    onClick={async () => void setScanFor(e.id)}
                    variant={"solid"}
                    colorPalette={"blue"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canWorkerCancel(e) && (
                  <StatusButton
                    id={"equipment-cancel"}
                    itemId={e.id}
                    label={"Cancel Reservation"}
                    onClick={async () => await cancel(e)}
                    variant={"outline"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canWorkerReturn(e) && (
                  <StatusButton
                    id={"equipment-return"}
                    itemId={e.id}
                    label={"Return"}
                    onClick={async () => void setScanReturnFor(e.id)}
                    variant={"solid"}
                    colorPalette={"orange"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canWorkerReserve(e) && (
                  <StatusButton
                    id={"equipment-reserve"}
                    itemId={e.id}
                    label={"Reserve"}
                    onClick={async () => { setReserveConfirmEquip(e); setReserveChecked(false); }}
                    variant={"solid"}
                    colorPalette={"yellow"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {purpose === "WORKER" && e.status === "AVAILABLE" && isTrainee && (
                  <HStack gap={1} fontSize="xs" color="gray.500"><AlertTriangle size={12} /><Text>Trainees cannot reserve equipment</Text></HStack>
                )}
                {purpose === "WORKER" && e.status === "AVAILABLE" && !isTrainee && e.requiresInsurance && !me?.isInsuranceValid && me?.workerType !== "EMPLOYEE" && me?.workerType !== "TRAINEE" && (
                  <HStack gap={1} fontSize="xs" color="orange.500"><AlertTriangle size={12} /><Text>Insurance required to reserve</Text></HStack>
                )}
                {canAdminForceRelease(e) && (
                  <StatusButton
                    id={"equipment-forceRelease"}
                    itemId={e.id}
                    label={"Force release"}
                    onClick={async () => await forceRelease(e)}
                    variant={"solid"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canAdminStartMaintenance(e) && (
                  <StatusButton
                    id={"equipment-startMaintenance"}
                    itemId={e.id}
                    label={"Start maintenance"}
                    onClick={async () => await startMaintainence(e)}
                    variant={"subtle"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canAdminEndMaintenance(e) && (
                  <StatusButton
                    id={"equipment-endMaintenance"}
                    itemId={e.id}
                    label={"End maintenance"}
                    onClick={async () => await endMaintainence(e)}
                    variant={"subtle"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canAdminRetire(e) && (
                  <StatusButton
                    id={"equipment-retire"}
                    itemId={e.id}
                    label={"Retire"}
                    onClick={async () => await retire(e)}
                    variant={"outline"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canAdminUnretire(e) && (
                  <StatusButton
                    id={"equipment-unretire"}
                    itemId={e.id}
                    label={"Unretire"}
                    onClick={async () => await unretire(e)}
                    variant={"subtle"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {canAdminHardDelete(e) && (
                  <StatusButton
                    id={"equipment-hardDelete"}
                    itemId={e.id}
                    label={"Delete"}
                    onClick={async () =>
                      void setToDelete({
                        id: e.id,
                        title: "Delete equipment?",
                        summary: e.shortDesc,
                        disabled: !isSuper,
                        details: (
                          <Text color="red.500">
                            You must be a Super Admin to delete.
                          </Text>
                        ),
                        extra: e.qrSlug,
                      })
                    }
                    variant={"danger-outline"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
              </HStack>
            </Card.Footer>
            )}
            </>
            )}
            {(e.instructions ?? []).length > 0 && (
              isCardCompact ? (
                <Box mx="3" mb="2" mt="0" display="flex" flexWrap="wrap" gap="1">
                  {(e.instructions ?? []).map((inst) => (
                    <HStack key={inst.id} gap="1" px="2" py="1" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                      <Text fontSize="xs" fontWeight="semibold" color="yellow.700">📌 {inst.text}</Text>
                    </HStack>
                  ))}
                </Box>
              ) : (
                <Box mx="3" mb="2" mt="0" px="3" py="1.5" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                  <VStack align="stretch" gap="0.5">
                    {(e.instructions ?? []).map((inst) => (
                      <Text key={inst.id} fontSize="xs" fontWeight="semibold" color="yellow.700">
                        📌 {inst.text}
                      </Text>
                    ))}
                  </VStack>
                </Box>
              )
            )}
          </Card.Root>
          );
        })}
            </VStack>}
          </Box>
        ))}
      </VStack>
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
        open={!!scanReturnFor}
        label="Scan QR Code to Return"
        onClose={() => void setScanReturnFor(null)}
        onDetected={async (slug) => {
          const id = scanReturnFor!;
          setStatusButtonBusyId(`equipment-return${id}`);
          setScanReturnFor(null);
          await returnVerifiedWithSlug(id, slug);
          setStatusButtonBusyId("");
        }}
      />
      {forAdmin && (
        <EquipmentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          role={forAdmin ? "ADMIN" : "WORKER"}
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {forAdmin && (
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
                        const rate = wt === "EMPLOYEE" ? reserveConfirmEquip.employeeDailyRate
                          : wt === "TRAINEE" ? null
                          : reserveConfirmEquip.dailyRate;
                        if (rate != null && rate > 0) {
                          return (
                            <Box mt={1} p={2} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.300">
                              <Text fontSize="sm" color="orange.800" fontWeight="semibold">
                                Rental charge: ${rate.toFixed(2)}/day
                              </Text>
                              <Text fontSize="xs" color="orange.600" mt={0.5}>
                                This amount will be deducted from your payout for each day the equipment is reserved.
                              </Text>
                            </Box>
                          );
                        }
                        return (
                          <Box mt={1} p={2} bg="green.50" rounded="md">
                            <Text fontSize="xs" color="green.700" fontWeight="medium">
                              {wt === "EMPLOYEE" ? "No charge — employees use equipment at no cost" : "No rental charge for this equipment"}
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

                    {(me?.workerType === "CONTRACTOR" || !me?.workerType) && (
                      <Box p={2} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.200">
                        <Text fontSize="sm" color="orange.700">
                          As a contractor, you are required to maintain valid general liability insurance
                          while using company equipment. Your insurance must cover any third-party claims
                          arising from your use of this equipment.
                        </Text>
                      </Box>
                    )}

                    {(() => {
                      const wt = me?.workerType;
                      if (wt === "TRAINEE") return null;
                      const rate = wt === "EMPLOYEE" ? reserveConfirmEquip.employeeDailyRate : reserveConfirmEquip.dailyRate;
                      if (rate == null || rate <= 0) return null;
                      return (
                        <Box p={2} bg="blue.50" rounded="md" borderWidth="1px" borderColor="blue.200">
                          <Text fontSize="sm" color="blue.700">
                            This equipment has a rental rate of <b>${rate.toFixed(2)} per day</b>.
                            Rental charges will be calculated based on the duration of your checkout and deducted from your earnings.
                          </Text>
                        </Box>
                      );
                    })()}

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
  );
}
