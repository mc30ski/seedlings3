import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Badge,
  Button,
  Dialog,
  Portal,
  useDisclosure,
} from "@chakra-ui/react";
import { useState, useRef } from "react";
import { apiPost, apiDelete } from "../../lib/api";
import { Role, Equipment } from "../../lib/types";
import {
  errorMessage,
  notifyEquipmentUpdated,
  prettyStatus,
  extractSlug,
  equipmentStatusColor,
} from "../../lib/lib";
import QRScannerDialog from "./QRScannerDialog";
import { InlineMessageType } from "../helpers/InlineMessage";

type EquipmentTileListProps = {
  item: Equipment;
  isMine: boolean;
  isSuper: boolean;
  role: Role;
  filter: string;
  refresh: any;
  setMessage: (msg: string, type: InlineMessageType) => void;
};

export default function EquipmentTileList({
  item,
  isMine,
  isSuper,
  role,
  filter,
  refresh,
  setMessage,
}: EquipmentTileListProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});
  const [toDelete, setToDelete] = useState<null | {
    id: string;
    label: string;
  }>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [scanFor, setScanFor] = useState<string | null>(null);
  const [scanReturnFor, setScanReturnFor] = useState<string | null>(null);

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

  function ActionButton({
    key,
    label,
    action,
    variant = "solid",
    disabled = false,
  }: {
    key: string;
    label: string;
    action: any;
    variant?: any;
    disabled?: boolean;
  }) {
    return (
      <Button
        key={key}
        variant={variant}
        onClick={action}
        disabled={!!busyId || disabled}
        loading={busyId === item.id}
      >
        {label}
      </Button>
    );
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
      setMessage("Equipment successfully reserved", InlineMessageType.SUCCESS);
    }
  }

  async function workerCancel(id: string) {
    if (await service(id, `/api/equipment/${id}/reserve/cancel`)) {
      setMessage(
        "Equipment reservation successully canceled",
        InlineMessageType.SUCCESS
      );
    }
  }

  async function adminForceRelease(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/release`)) {
      setMessage("Equipment successfully released", InlineMessageType.SUCCESS);
    }
  }

  async function adminStartMaintainence(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/maintenance/start`)) {
      setMessage(
        "Equipment maintenance successfully started",
        InlineMessageType.SUCCESS
      );
    }
  }

  async function adminEndMaintainence(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/maintenance/end`)) {
      setMessage(
        "Equipment maintenance successfully ended",
        InlineMessageType.SUCCESS
      );
    }
  }

  async function adminRetire(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/retire`)) {
      setMessage("Equipment successfully retired", InlineMessageType.SUCCESS);
    }
  }

  async function adminUnretire(id: string) {
    if (await service(id, `/api/admin/equipment/${id}/unretire`)) {
      setMessage("Equipment successfully unretired", InlineMessageType.SUCCESS);
    }
  }

  async function adminHardDelete(id: string) {
    if (await service(id, `/api/admin/equipment/${id}`, true)) {
      setMessage("Equipment successfully deleted", InlineMessageType.SUCCESS);
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
    role === "WORKER" && filter === "claimed" && item.status === "RESERVED";
  const canWorkerCancel = (e: Equipment) =>
    role === "WORKER" && filter === "claimed" && item.status === "RESERVED";
  const canWorkerReturn = (e: Equipment) =>
    role === "WORKER" && filter === "claimed" && item.status === "CHECKED_OUT";
  const canWorkerReserve = (e: Equipment) =>
    role === "WORKER" && filter === "available" && item.status === "AVAILABLE";

  const canAdminForceRelease = (e: Equipment) => role === "ADMIN" && !!e.holder;
  const canAdminStartMaintenance = (e: Equipment) =>
    role === "ADMIN" &&
    e.status !== "RETIRED" &&
    e.status !== "MAINTENANCE" &&
    !e.holder;
  const canAdminEndMaintenance = (e: Equipment) =>
    role === "ADMIN" && e.status === "MAINTENANCE";
  const canAdminRetire = (e: Equipment) =>
    role === "ADMIN" &&
    e.status !== "RETIRED" &&
    !e.holder &&
    e.status !== "RESERVED" &&
    e.status !== "CHECKED_OUT";
  const canAdminUnretire = (e: Equipment) =>
    role === "ADMIN" && e.status === "RETIRED";
  const canAdminHardDelete = (e: Equipment) =>
    role === "ADMIN" && e.status === "RETIRED";

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
          setMessage(
            "Equipment successfully checked in",
            InlineMessageType.SUCCESS
          );
        }}
      />

      <QRScannerDialog
        open={!!scanReturnFor}
        label="Scan QR Code to Return"
        onClose={() => {
          setScanReturnFor(null);
          setMessage(
            "Equipment successfully returned",
            InlineMessageType.SUCCESS
          );
        }}
        onDetected={(slug) => {
          const id = scanReturnFor!;
          setScanReturnFor(null);
          void workerReturnVerifiedWithSlug(id, slug);
        }}
      />

      <Box
        key={item.id}
        p={4}
        borderWidth="1px"
        borderRadius="lg"
        mb={3}
        w="full"
      >
        <HStack justify="space-between" align="start" w="full">
          <Box flex="1" w="full">
            <HStack w="full" justify="space-between" align="center">
              <Heading size="md" color="gray.400">
                {item.type ?? ""}
              </Heading>
              <Badge colorPalette={equipmentStatusColor(item.status)}>
                {prettyStatus(item.status)}
                {isMine &&
                (item.status === "RESERVED" || item.status === "CHECKED_OUT")
                  ? " (You)"
                  : ""}
              </Badge>
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

            <Stack direction={{ base: "column", sm: "row" }} gap="2" mt={2}>
              {" "}
              <>
                {canWorkerCheckout(item) && (
                  <ActionButton
                    key="worker_checkout"
                    label="Check Out"
                    action={() => setScanFor(item.id)}
                  />
                )}
                {canWorkerCancel(item) && (
                  <ActionButton
                    key="worker_cancel"
                    label="Cancel Reservation"
                    action={() => void workerCancel(item.id)}
                    variant="outline"
                  />
                )}
                {canWorkerReturn(item) && (
                  <ActionButton
                    key="worker_return"
                    label="Return"
                    action={() => setScanReturnFor(item.id)}
                  />
                )}
                {canWorkerReserve(item) && (
                  <ActionButton
                    key="worker_reserve"
                    label="Reserve"
                    action={() => void workerReserve(item.id)}
                  />
                )}
                {canAdminForceRelease(item) && (
                  <ActionButton
                    key="admin_forceRelease"
                    label="Force release"
                    action={() => void adminForceRelease(item.id)}
                  />
                )}
                {canAdminStartMaintenance(item) && (
                  <ActionButton
                    key="admin_startMaintenance"
                    label="Start maintenance"
                    action={() => void adminStartMaintainence(item.id)}
                    variant="subtle"
                  />
                )}
                {canAdminEndMaintenance(item) && (
                  <ActionButton
                    key="admin_endMaintenance"
                    label="End maintenance"
                    action={() => void adminEndMaintainence(item.id)}
                    variant="subtle"
                  />
                )}
                {canAdminRetire(item) && (
                  <ActionButton
                    key="admin_retire"
                    label="Retire"
                    action={() => void adminRetire(item.id)}
                    variant="outline"
                  />
                )}
                {canAdminUnretire(item) && (
                  <ActionButton
                    key="admin_unretire"
                    label="Unretire"
                    action={() => void adminUnretire(item.id)}
                    variant="subtle"
                  />
                )}
                {canAdminHardDelete(item) && (
                  <ActionButton
                    key="admin_hardDelete"
                    label="Delete"
                    action={() =>
                      setToDelete({
                        id: item.id,
                        label:
                          [item.brand, item.model, item.shortDesc]
                            .filter(Boolean)
                            .join(" ") ||
                          item.shortDesc ||
                          item.id,
                      })
                    }
                    variant="danger-outline"
                  />
                )}
              </>
            </Stack>
          </Box>
        </HStack>
      </Box>

      <Dialog.Root
        role="alertdialog"
        open={!!toDelete}
        onOpenChange={(e) => !e.open && setToDelete(null)}
        initialFocusEl={() => cancelRef.current}
        placement="center"
      >
        <Portal>
          {/* Backdrop below */}
          <Dialog.Backdrop zIndex={1500} />

          {/* Positioner + Content above */}
          <Dialog.Positioner zIndex={1600}>
            <Dialog.Content
              maxW={{ base: "calc(100vw - 2rem)", sm: "420px" }}
              w="full"
              mx="auto"
              my={{ base: "1rem", sm: "10vh" }}
              maxH="80vh"
              overflowY="auto"
              // Make sure the panel isn't transparent
              bg="white"
              _dark={{ bg: "gray.800" }}
              // optional niceties
              borderRadius="lg"
              boxShadow="lg"
            >
              <Dialog.Header>Delete equipment?</Dialog.Header>
              <Dialog.Body>
                <Text mb="2">
                  This will <b>permanently delete</b> the equipment record:
                </Text>
                {toDelete?.label ? (
                  <Text mb="2" color="gray.600">
                    {toDelete.label}
                  </Text>
                ) : null}
                {!isSuper && (
                  <Text color="red.500">
                    You must be a Super Admin to delete.
                  </Text>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full" gap="2">
                  <Dialog.CloseTrigger asChild>
                    <Button ref={cancelRef} variant="outline">
                      Cancel
                    </Button>
                  </Dialog.CloseTrigger>
                  <Button
                    variant={"danger" as any}
                    onClick={async () => {
                      if (!toDelete) return;
                      try {
                        await adminHardDelete(toDelete.id);
                      } finally {
                        setToDelete(null);
                      }
                    }}
                    disabled={!isSuper}
                  >
                    Delete
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
