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
import { AlertTriangle, Filter, LayoutList, List, Maximize2, Plus, RefreshCw, X } from "lucide-react";
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
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import EquipmentDialog from "@/src/ui/dialogs/EquipmentDialog";

import { EQUIPMENT_KIND, EQUIPMENT_STATUS } from "@/src/lib/types";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...EQUIPMENT_KIND] as const;

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
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(
    `${pfx}_status`, purpose === "WORKER" ? ["CLAIMED"] : ["ALL"]
  );
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Equipment[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [scanReturnFor, setScanReturnFor] = useState<string | null>(null);
  const [reserveConfirmEquip, setReserveConfirmEquip] = useState<Equipment | null>(null);
  const [reserveChecked, setReserveChecked] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Helper variable to disable other buttons while actions are in flight.
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Used to create the dropdown menus.
  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  const statusItems = useMemo(
    () =>
      (forAdmin ? adminStatusStates : workerStatusStates).map((s) => ({
        label: prettyStatus(s),
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
  }, [forAdmin]);

  useEffect(() => {
    onEventSearchRun("activityTavToEquipmentTabQRCodeSearch", setQ, inputRef);
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    let rows = items;

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

    return rows;
  }, [items, q, kind, statusFilter, forAdmin]);

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
    purpose === "WORKER" && e.status === "RESERVED";
  const canWorkerCancel = (e: Equipment) =>
    purpose === "WORKER" && e.status === "RESERVED";
  const canWorkerReturn = (e: Equipment) =>
    purpose === "WORKER" && e.status === "CHECKED_OUT";
  const isTrainee = me?.workerType === "TRAINEE";
  const canWorkerReserve = (e: Equipment) =>
    purpose === "WORKER" &&
    e.status === "AVAILABLE" &&
    !isTrainee &&
    (!e.requiresInsurance || me?.isInsuranceValid);

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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-blue-100)", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-purple-100)", borderRadius: "6px" }}>
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
        {!(kind[0] === "ALL" && statusFilter[0] === "ALL") && (
        <Button
          variant="outline"
          size="xs"
          colorPalette="red"
          onClick={() => {
            setKind(["ALL"]);
            setStatusFilter(["ALL"]);
          }}
        >
          Clear
        </Button>
        )}
        <Button
          variant={compact ? "solid" : "ghost"}
          size="sm"
          px="2"
          minW="0"
          onClick={() => { setCompact((v) => !v); setExpandedCards(new Set()); }}
          css={compact ? {
            background: "var(--chakra-colors-gray-200)",
            color: "var(--chakra-colors-gray-700)",
          } : undefined}
        >
          {compact ? <Maximize2 size={14} /> : <List size={14} />}
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
      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL") && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {kind[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="subtle">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="subtle">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
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
        {filtered.map((e: Equipment) => {
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
            <Card.Header py="3" px="4" pb="0">
              <Box display="flex" flexDirection={{ base: "column", md: "row" }} gap={{ base: 1, md: 3 }} justifyContent="space-between" alignItems={{ md: "center" }}>
                <Text fontSize={isCardCompact ? "sm" : "md"} fontWeight="semibold">{e.shortDesc}</Text>
                <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" flexShrink={0}>
                  <StatusBadge
                    status={e.status ?? ""}
                    palette={equipmentStatusColor(e.status ?? "")}
                    variant="subtle"
                  />
                  <StatusBadge status={e.type} palette="gray" variant="outline" />
                  {e.requiresInsurance && (
                    <span title="Valid insurance required to reserve this equipment">
                      <StatusBadge status="Insured" palette="orange" variant="subtle" />
                    </span>
                  )}
                </Box>
              </Box>
            </Card.Header>
            {isCardCompact ? (
              <Card.Body py="3" px="4" pt="0">
                <HStack gap={2} fontSize="xs" color="fg.muted">
                  <Text>
                    {e.brand ? `${e.brand} ` : ""}
                    {e.model ? `${e.model} ` : ""}
                  </Text>
                  {forAdmin ? (
                    e.dailyRate != null && e.dailyRate > 0 ? (
                      <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                        ${e.dailyRate.toFixed(2)}/day
                      </Badge>
                    ) : null
                  ) : (me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE") ? (
                    <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                      No charge (employee)
                    </Badge>
                  ) : e.dailyRate != null && e.dailyRate > 0 ? (
                    <Badge colorPalette="orange" variant="solid" fontSize="xs" px="1.5" borderRadius="full">
                      ${e.dailyRate.toFixed(2)}/day rental
                    </Badge>
                  ) : (
                    <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                      No charge
                    </Badge>
                  )}
                  {e.holder && (
                    <Text color="orange.500" fontWeight="medium">
                      {e.holder.state === "CHECKED_OUT" ? "Out: " : "Reserved: "}
                      {e.holder.displayName || e.holder.email || e.holder.userId.slice(0, 8)}
                    </Text>
                  )}
                </HStack>
              </Card.Body>
            ) : (
            <Card.Body py="3" px="4" pt="0">
              <VStack align="start" gap={0}>
                <Text fontSize="sm" color="fg.muted">
                  {e.brand ? `${e.brand} ` : ""}
                  {e.model ? `${e.model} ` : ""}
                </Text>
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
                  <VStack align="start" gap={0} mt={0.5} fontSize="xs">
                    <HStack gap={2}>
                      <Text color="fg.muted">Employee:</Text>
                      <Badge colorPalette="green" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">No charge</Badge>
                    </HStack>
                    <HStack gap={2}>
                      <Text color="fg.muted">Contractor:</Text>
                      {e.dailyRate != null && e.dailyRate > 0 ? (
                        <Badge colorPalette="orange" variant="solid" fontSize="xs" px="1.5" borderRadius="full">
                          ${e.dailyRate.toFixed(2)}/day
                        </Badge>
                      ) : (
                        <Text color="green.500">No charge</Text>
                      )}
                    </HStack>
                  </VStack>
                ) : (me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE") ? (
                  <HStack gap={2} mt={0.5}>
                    <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                      No charge — employees use equipment at no cost
                    </Badge>
                    {e.dailyRate != null && e.dailyRate > 0 && (
                      <Text fontSize="xs" color="gray.400">(${e.dailyRate.toFixed(2)}/day for contractors)</Text>
                    )}
                  </HStack>
                ) : e.dailyRate != null && e.dailyRate > 0 ? (
                  <HStack gap={2} mt={0.5}>
                    <Badge colorPalette="orange" variant="solid" fontSize="xs" px="2" borderRadius="full">
                      ${e.dailyRate.toFixed(2)}/day
                    </Badge>
                    <Text fontSize="xs" color="orange.500">rental cost</Text>
                  </HStack>
                ) : (
                  <Text fontSize="xs" color="green.500" mt={0.5}>No rental cost</Text>
                )}
                {/* Minimal collapsible for details */}
                <ItemTile item={e} isMine={isMine(e)} />
                {unavailableMessage(e)}
              </VStack>
            </Card.Body>
            )}
            {!isCardCompact && (
            <Card.Footer py="3" px="4" pt="0">
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
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                )}
                {purpose === "WORKER" && e.status === "AVAILABLE" && isTrainee && (
                  <HStack gap={1} fontSize="xs" color="gray.500"><AlertTriangle size={12} /><Text>Trainees cannot reserve equipment</Text></HStack>
                )}
                {purpose === "WORKER" && e.status === "AVAILABLE" && !isTrainee && e.requiresInsurance && !me?.isInsuranceValid && (
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
          </Card.Root>
          );
        })}
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
                      {(me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE") ? (
                        <Box mt={1} p={2} bg="green.50" rounded="md">
                          <Text fontSize="xs" color="green.700" fontWeight="medium">
                            No charge — employees use equipment at no cost
                          </Text>
                        </Box>
                      ) : reserveConfirmEquip.dailyRate != null && reserveConfirmEquip.dailyRate > 0 ? (
                        <Box mt={1} p={2} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.300">
                          <Text fontSize="sm" color="orange.800" fontWeight="semibold">
                            Rental charge: ${reserveConfirmEquip.dailyRate.toFixed(2)}/day
                          </Text>
                          <Text fontSize="xs" color="orange.600" mt={0.5}>
                            This amount will be deducted from your payout for each day the equipment is reserved.
                          </Text>
                        </Box>
                      ) : (
                        <Box mt={1} p={2} bg="green.50" rounded="md">
                          <Text fontSize="xs" color="green.700" fontWeight="medium">No rental charge for this equipment</Text>
                        </Box>
                      )}
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

                    {reserveConfirmEquip.dailyRate != null && reserveConfirmEquip.dailyRate > 0 &&
                      me?.workerType !== "EMPLOYEE" && me?.workerType !== "TRAINEE" && (
                      <Box p={2} bg="blue.50" rounded="md" borderWidth="1px" borderColor="blue.200">
                        <Text fontSize="sm" color="blue.700">
                          This equipment has a rental rate of <b>${reserveConfirmEquip.dailyRate.toFixed(2)} per day</b>.
                          Rental charges will be calculated based on the duration of your checkout and deducted from your earnings.
                        </Text>
                      </Box>
                    )}

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
    </Box>
  );
}
