"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Box,
  Button,
  Badge,
  Card,
  HStack,
  Spacer,
  Text,
  VStack,
  Select,
  useDisclosure,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import {
  determineRoles,
  prettyStatus,
  notifyEquipmentUpdated,
  extractSlug,
  equipmentStatusColor,
} from "@/src/lib/lib";
import { TabPropsType, EquipmentStatus, Equipment } from "@/src/lib/types";
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
  "CLAIMED",
  "AVAILABLE",
  "UNAVAILABLE",
  "ALL",
] as const;
const adminStatusStates = ["ALL", ...EQUIPMENT_STATUS] as const;

export default function EquipmenTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isSuper, isAvail, forAdmin } = determineRoles(me, purpose);

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(
    purpose === "WORKER" ? "CLAIMED" : "ALL"
  );
  const [kind, setKind] = useState<string[]>(["ALL"]);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Equipment[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Equipment | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [scanReturnFor, setScanReturnFor] = useState<string | null>(null);

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

  // Used to pre-populate the search with information (e.g. QR slug)
  useEffect(() => {
    const onRun = (ev: Event) => {
      const { q } = (ev as CustomEvent<{ q?: string }>).detail || {};
      if (typeof q === "string") {
        setQ(q);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    };
    window.addEventListener("equipmentSearch:run", onRun as EventListener);
    return () =>
      window.removeEventListener("equipmentSearch:run", onRun as EventListener);
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    let rows = items;

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.type === kind[0]);
    }

    if (status !== "ALL") {
      let want: EquipmentStatus[] | null = null;
      if (forAdmin) {
        want = [status as EquipmentStatus];
      } else {
        switch (status) {
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
  }, [items, q, kind, status]);

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
    purpose === "WORKER" && status === "CLAIMED" && e.status === "RESERVED";
  const canWorkerCancel = (e: Equipment) =>
    purpose === "WORKER" && status === "CLAIMED" && e.status === "RESERVED";
  const canWorkerReturn = (e: Equipment) =>
    purpose === "WORKER" && status === "CLAIMED" && e.status === "CHECKED_OUT";
  const canWorkerReserve = (e: Equipment) =>
    purpose === "WORKER" && e.status === "AVAILABLE";

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
                    <Text fontSize="sm" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Description:{" "}
                      </Text>
                      {item.longDesc}
                    </Text>
                  )}
                  {item.features && (
                    <Text fontSize="sm" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Features:{" "}
                      </Text>
                      {item.features}
                    </Text>
                  )}
                  {item.condition && (
                    <Text fontSize="sm" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Condition:{" "}
                      </Text>
                      {item.condition}
                    </Text>
                  )}
                  {item.issues && (
                    <Text fontSize="sm" color="gray.500" mt={1}>
                      <Text as="span" fontWeight="bold">
                        Issues:{" "}
                      </Text>
                      {item.issues}
                    </Text>
                  )}
                  {item.age && (
                    <Text fontSize="sm" color="gray.500" mt={1}>
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
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={3} gap={3}>
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
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Kind" />
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
        <Spacer />
        {forAdmin && <Button onClick={openCreate}>New</Button>}
      </HStack>
      <HStack mb={3} gap={2} wrap="wrap">
        {(forAdmin ? adminStatusStates : workerStatusStates)
          .map((s) => ({
            label: prettyStatus(s),
            val: s,
          }))
          .map(({ label, val }) => (
            <Button
              key={val}
              size="sm"
              variant={status === val ? "solid" : "outline"}
              onClick={() => {
                setStatus(val);
              }}
            >
              {label}
            </Button>
          ))}
      </HStack>
      <VStack align="stretch" gap={3}>
        {!loading && filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No properties match current filters.
          </Box>
        )}
        {filtered.map((e: Equipment) => (
          <Card.Root key={e.id} variant="outline">
            <Card.Header pb="2">
              <HStack gap={3} justify="space-between" align="center">
                <HStack gap={3} flex="1" minW={0}>
                  <Text fontWeight="semibold">{e.shortDesc}</Text>
                  <StatusBadge
                    status={e.status ?? ""}
                    palette={equipmentStatusColor(e.status ?? "")}
                    variant="subtle"
                  />
                </HStack>
                <StatusBadge status={e.type} palette="gray" variant="outline" />
              </HStack>
            </Card.Header>
            <Card.Body pt="0">
              <VStack align="start" gap={0}>
                <Text fontSize="sm" color="fg.muted">
                  {e.brand ? `${e.brand} ` : ""}
                  {e.model ? `${e.model} ` : ""}
                </Text>
                {e.qrSlug && (
                  <Text fontSize="sm" color="gray.500" mt={0}>
                    <Text as="span" fontWeight="bold">
                      ID:{" "}
                    </Text>
                    {e.qrSlug}
                  </Text>
                )}
                {e.energy && (
                  <Text fontSize="sm" color="gray.500" mt={0}>
                    <Text as="span" fontWeight="bold">
                      Power:{" "}
                    </Text>
                    {e.energy}
                  </Text>
                )}
                {/* Minimal collapsible for details */}
                <ItemTile item={e} isMine={isMine(e)} />
                {unavailableMessage(e)}
              </VStack>
            </Card.Body>
            <Card.Footer>
              <HStack gap={2} wrap="wrap" mb="2">
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
                    onClick={async () => await reserve(e)}
                    variant={"solid"}
                    disabled={loading}
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
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
          </Card.Root>
        ))}
      </VStack>

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
    </Box>
  );
}
