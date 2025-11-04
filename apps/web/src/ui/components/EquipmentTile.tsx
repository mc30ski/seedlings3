import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  VStack,
  Badge,
  Button,
  useDisclosure,
} from "@chakra-ui/react";
import { useState } from "react";
import { apiPost, apiDelete } from "@/src/lib/api";
import EquipmentDialog, { Equipment } from "@/src/ui/dialogs/EquipmentDialog";
import {
  errorMessage,
  notifyEquipmentUpdated,
  prettyStatus,
  extractSlug,
  equipmentStatusColor,
} from "@/src/lib/lib";
import QRScannerDialog from "@/src/ui/dialogs/QRScannerDialog";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
//import ActionButton from "@/src/ui/components/ActionButton";

type EquipmentTileListProps = {
  item: Equipment;
  isMine: boolean;
  isSuper: boolean;
  role: "worker" | "admin";
  filter: string;
  refresh: any;
};

export default function EquipmentTileList({
  item,
  isMine,
  isSuper,
  role,
  filter,
  refresh,
}: EquipmentTileListProps) {
  const isAdmin = role === "admin";
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [scanReturnFor, setScanReturnFor] = useState<string | null>(null);
  const [dialogEditOpen, setDialogEditOpen] = useState(false);

  const dismissInline = (id: string) =>
    setInlineWarn((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });

  function captureInlineConflict(id: string, err: any) {
    const status =
      err?.status ?? err?.httpStatus ?? err?.response?.status ?? undefined;
    setInlineWarn((m) => ({
      ...m,
      [id]: errorMessage(err),
    }));
  }

  async function service(
    id: string,
    url: string,
    remove: boolean = false,
    body: any = undefined
  ) {
    setBusyId(id);
    try {
      remove ? await apiDelete(url) : await apiPost(url, body);
      dismissInline(id);
      notifyEquipmentUpdated();
      await refresh();
      return true;
    } catch (err: any) {
      captureInlineConflict(id, err);
      return false;
    } finally {
      setBusyId(null);
    }
  }

  //async function workerCheckout(id: string) {
  //  service(id, `/api/equipment/${id}/checkout`);
  //}

  //async function workerReturn(id: string) {
  //  await service(id, `/api/equipment/${id}/return`);
  //}

  async function workerCheckoutVerifiedWithSlug(id: string, slug: string) {
    await service(id, `/api/equipment/${id}/checkout/verify`, false, {
      slug: extractSlug(slug),
    });
  }

  async function workerReturnVerifiedWithSlug(id: string, slug: string) {
    await service(id, `/api/equipment/${id}/return/verify`, false, {
      slug: extractSlug(slug),
    });
  }

  async function workerReserve(id: string) {
    if (await service(id, `/api/equipment/${id}/reserve`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment successfully reserved",
      });
    }
  }

  async function workerCancel(id: string) {
    if (await service(id, `/api/equipment/${id}/reserve/cancel`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment reservation successully canceled",
      });
    }
  }

  async function adminForceRelease(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/release`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment successfully released",
      });
    }
  }

  async function adminStartMaintainence(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/maintenance/start`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment maintenance successfully started",
      });
    }
  }

  async function adminEndMaintainence(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/maintenance/end`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment maintenance successfully ended",
      });
    }
  }

  async function adminRetire(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/retire`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment successfully retired",
      });
    }
  }

  async function adminUnretire(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/unretire`)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment successfully unretired",
      });
    }
  }

  async function adminHardDelete(id: string) {
    if (await service(id, `/api/admin/equipment/${id}`, true)) {
      publishInlineMessage({
        type: "SUCCESS",
        text: "Equipment successfully deleted",
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
    role === "worker" && filter === "claimed" && item.status === "RESERVED";
  const canWorkerCancel = (e: Equipment) =>
    role === "worker" && filter === "claimed" && item.status === "RESERVED";
  const canWorkerReturn = (e: Equipment) =>
    role === "worker" && filter === "claimed" && item.status === "CHECKED_OUT";
  const canWorkerReserve = (e: Equipment) =>
    role === "worker" && filter === "available" && item.status === "AVAILABLE";

  const canAdminForceRelease = (e: Equipment) => role === "admin" && !!e.holder;
  const canAdminStartMaintenance = (e: Equipment) =>
    role === "admin" &&
    e.status !== "RETIRED" &&
    e.status !== "MAINTENANCE" &&
    !e.holder;
  const canAdminEndMaintenance = (e: Equipment) =>
    role === "admin" && e.status === "MAINTENANCE";
  const canAdminRetire = (e: Equipment) =>
    role === "admin" &&
    e.status !== "RETIRED" &&
    !e.holder &&
    e.status !== "RESERVED" &&
    e.status !== "CHECKED_OUT";
  const canAdminUnretire = (e: Equipment) =>
    role === "admin" && e.status === "RETIRED";
  const canAdminHardDelete = (e: Equipment) =>
    role === "admin" && e.status === "RETIRED";

  function ItemTile({ item, isMine }: { item: any; isMine?: boolean }) {
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

  return (
    <>
      <Box
        key={item.id}
        p={4}
        borderWidth="1px"
        borderRadius="lg"
        mb={3}
        w="full"
      >
        <HStack align="start" gap="2">
          <VStack alignItems="start" gap={1} flex="1">
            <Heading size="sm" color="gray.400">
              {item.type ?? ""}
            </Heading>
            <HStack gap="2" wrap="wrap">
              <Badge colorPalette={equipmentStatusColor(item.status ?? "")}>
                {prettyStatus(item.status ?? "")}
              </Badge>
            </HStack>
          </VStack>
          {isAdmin && (
            <HStack gap="2">
              <Button
                variant="outline"
                onClick={() => void setDialogEditOpen(true)}
              >
                Edit
              </Button>
              <Button
                variant="outline"
                colorPalette="red"
                onClick={() =>
                  void setToDelete({
                    id: item.id,
                    title: "Delete client and contacts?",
                    summary: item.brand,
                    disabled: !isSuper,
                    details: (
                      <Text color="red.500">
                        You must be a Super Admin to delete.
                      </Text>
                    ),
                  })
                }
              >
                Delete
              </Button>
            </HStack>
          )}
        </HStack>

        {item.shortDesc && <Heading size="md">{item.shortDesc}</Heading>}

        <Heading size="sm">
          {item.brand ? `${item.brand} ` : ""}
          {item.model ? `${item.model} ` : ""}
        </Heading>

        {item.qrSlug && (
          <Text fontSize="sm" color="gray.500" mt={1}>
            <Text as="span" fontWeight="bold">
              ID:{" "}
            </Text>
            {item.qrSlug}
          </Text>
        )}

        {item.energy && (
          <Text fontSize="sm" color="gray.500" mt={1}>
            <Text as="span" fontWeight="bold">
              Power:{" "}
            </Text>
            {item.energy}
          </Text>
        )}

        {/* Minimal collapsible for details */}
        <ItemTile item={item} isMine={isMine} />

        {unavailableMessage(item)}

        {/* Inline warning banner for this item */}
        {inlineWarn[item.id] && (
          <HStack
            w="full"
            mt={2}
            align="start"
            p={2.5}
            borderRadius="md"
            borderWidth="1px"
            borderColor="orange.300"
            bg="orange.50"
          >
            <Box flex="1">
              <Text fontSize="sm" color="orange.900">
                {inlineWarn[item.id]}
              </Text>
            </Box>
            <Button
              size="xs"
              variant="ghost"
              ml="auto"
              onClick={() => dismissInline(item.id)}
            >
              Dismiss
            </Button>
          </HStack>
        )}

        <Stack
          direction={{ base: "column", sm: "row" }}
          gap="2"
          mt={2}
          wrap="wrap"
        >
          <Box flexBasis="100%" w="full" minW={0}>
            <HStack gap={2}>
              {/* 
              {canWorkerCheckout(item) && (
                <ActionButton
                  key="worker_checkout"
                  label="Check Out"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => setScanFor(item.id)}
                />
              )}
              {canWorkerCancel(item) && (
                <ActionButton
                  key="worker_cancel"
                  label="Cancel Reservation"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void workerCancel(item.id)}
                  variant="outline"
                />
              )}
              {canWorkerReturn(item) && (
                <ActionButton
                  key="worker_return"
                  label="Return"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => setScanReturnFor(item.id)}
                />
              )}
              {canWorkerReserve(item) && (
                <ActionButton
                  key="worker_reserve"
                  label="Reserve"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void workerReserve(item.id)}
                />
              )}
              {canAdminForceRelease(item) && (
                <ActionButton
                  key="admin_forceRelease"
                  label="Force release"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void adminForceRelease(item.id)}
                />
              )}
              {canAdminStartMaintenance(item) && (
                <ActionButton
                  key="admin_startMaintenance"
                  label="Start maintenance"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void adminStartMaintainence(item.id)}
                  variant="subtle"
                />
              )}
              {canAdminEndMaintenance(item) && (
                <ActionButton
                  key="admin_endMaintenance"
                  label="End maintenance"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void adminEndMaintainence(item.id)}
                  variant="subtle"
                />
              )}
              {canAdminRetire(item) && (
                <ActionButton
                  key="admin_retire"
                  label="Retire"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void adminRetire(item.id)}
                  variant="outline"
                />
              )}
              {canAdminUnretire(item) && (
                <ActionButton
                  key="admin_unretire"
                  label="Unretire"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() => void adminUnretire(item.id)}
                  variant="subtle"
                />
              )}
              {canAdminHardDelete(item) && (
                <ActionButton
                  key="admin_hardDelete"
                  label="Delete"
                  itemId={item.id}
                  busyId={busyId ?? ""}
                  action={() =>
                    void setToDelete({
                      id: item.id,
                      title: "Delete equipment?",
                      summary: item.shortDesc,
                      disabled: !isSuper,
                      details: (
                        <Text color="red.500">
                          You must be a Super Admin to delete.
                        </Text>
                      ),
                    })
                  }
                  variant="danger-outline"
                />
              )}*/}
            </HStack>
          </Box>
        </Stack>
      </Box>

      <QRScannerDialog
        open={!!scanFor}
        label="Scan QR Code to Check Out"
        onClose={() => {
          setScanFor(null);
        }}
        onDetected={(slug) => {
          const id = scanFor!;
          setScanFor(null);
          workerCheckoutVerifiedWithSlug(id, slug);
          publishInlineMessage({
            type: "SUCCESS",
            text: "Equipment successfully checked in",
          });
        }}
      />

      <QRScannerDialog
        open={!!scanReturnFor}
        label="Scan QR Code to Return"
        onClose={() => {
          setScanReturnFor(null);
          publishInlineMessage({
            type: "SUCCESS",
            text: "Equipment successfully returned",
          });
        }}
        onDetected={(slug) => {
          const id = scanReturnFor!;
          setScanReturnFor(null);
          void workerReturnVerifiedWithSlug(id, slug);
        }}
      />

      <DeleteDialog
        toDelete={toDelete}
        cancel={() => setToDelete(null)}
        complete={async () => {
          if (!toDelete) return;
          try {
            await adminHardDelete(toDelete.id);
          } catch (err) {
            publishInlineMessage({
              type: "ERROR",
              text: `Delete error occurred: ${errorMessage(err)}`,
            });
          } finally {
            setToDelete(null);
          }
        }}
      />

      <EquipmentDialog
        open={dialogEditOpen}
        onOpenChange={setDialogEditOpen}
        mode="update"
        initial={{ ...item }}
        onSaved={() => void refresh()}
        actionLabel={"Update"}
      />
    </>
  );
}
