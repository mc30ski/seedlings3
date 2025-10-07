import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Badge,
  Button,
  Dialog,
} from "@chakra-ui/react";
import { useState, useRef } from "react";
import { apiPost, apiDelete } from "../../lib/api";
import { Role, Equipment, StatusColor } from "../../lib/types";
import {
  errorMessage,
  notifyEquipmentUpdated,
  prettyStatus,
} from "../../lib/lib";

type EquipmentTileProps = {
  item: Equipment;
  isMine: boolean;
  role: Role;
  filter: string;
  refresh: any;
};

export default function EquipmentTile({
  item,
  isMine,
  role,
  filter,
  refresh,
}: EquipmentTileProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});
  const [toDelete, setToDelete] = useState<null | {
    id: string;
    label: string;
  }>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

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
  }: {
    key: string;
    label: string;
    action: any;
    variant?: any;
  }) {
    return (
      <Button
        key={key}
        variant={variant}
        onClick={action}
        disabled={!!busyId}
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
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  async function workerCheckout(id: string) {
    service(id, `/api/equipment/${id}/checkout`);
  }

  async function workerReserve(id: string) {
    service(id, `/api/equipment/${id}/reserve`);
  }

  async function workerCancel(id: string) {
    service(id, `/api/equipment/${id}/reserve/cancel`);
  }

  async function workerReturn(id: string) {
    service(id, `/api/equipment/${id}/return`);
  }

  async function adminForceRelease(id: string) {
    service(id, `/api/admin/equipment/${id}/release`);
  }

  async function adminStartMaintainence(id: string) {
    service(id, `/api/admin/equipment/${id}/maintenance/start`);
  }

  async function adminEndMaintainence(id: string) {
    service(id, `/api/admin/equipment/${id}/maintenance/end`);
  }

  async function adminRetire(id: string) {
    service(id, `/api/admin/equipment/${id}/retire`);
  }

  async function adminUnretire(id: string) {
    service(id, `/api/admin/equipment/${id}/unretire`);
  }

  async function adminHardDelete(id: string) {
    service(id, `/api/admin/equipment/${id}`, true);
  }

  function unavailableMessage(item: Equipment) {
    if (
      filter !== "claimed" &&
      (item.holder?.state === "CHECKED_OUT" ||
        item.holder?.state === "RESERVED")
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
        <Text fontSize="xs" color="gray.700" mt={1}>
          {str}
        </Text>
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
        <HStack justify="space-between" align="start" w="full">
          <Box flex="1" w="full">
            <Heading size="md">{item.type ? `${item.type} ` : ""}</Heading>
            <Heading size="sm">
              {item.brand ? `${item.brand} ` : ""}
              {item.model ? `${item.model} ` : ""}
              <Badge ml={2} {...StatusColor[item.status]}>
                {prettyStatus(item.status)}
                {isMine &&
                (item.status === "RESERVED" || item.status === "CHECKED_OUT")
                  ? " (You)"
                  : ""}
              </Badge>
            </Heading>

            {unavailableMessage(item)}

            {item.shortDesc && (
              <Text fontSize="sm" color="gray.600" mt={1}>
                {item.shortDesc}
              </Text>
            )}

            {item.longDesc && (
              <Text fontSize="sm" color="gray.500" mt={1}>
                {item.longDesc}
              </Text>
            )}

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

            <Stack direction="row" gap="2" mt={2}>
              <>
                {canWorkerCheckout(item) && (
                  <ActionButton
                    key="worker_checkout"
                    label="Check Out"
                    action={() => void workerCheckout(item.id)}
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
                    action={() => void workerReturn(item.id)}
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
      >
        <Dialog.Content>
          <Dialog.Header>Delete equipment?</Dialog.Header>
          <Dialog.Body>
            <Text mb="2">
              This will <b>permanently delete</b> the equipment record.
            </Text>
            {toDelete?.label ? (
              <Text color="gray.600">Item: {toDelete.label}</Text>
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <HStack justify="flex-end" w="full" gap="2">
              <Dialog.CloseTrigger asChild>
                <Button ref={cancelRef} variant="outline">
                  Cancel
                </Button>
              </Dialog.CloseTrigger>

              {/* Destructive action */}
              <Button
                variant={"danger" as any}
                onClick={async () => {
                  if (!toDelete) return;
                  try {
                    // call your existing delete function here
                    await adminHardDelete(toDelete.id);
                  } finally {
                    setToDelete(null);
                  }
                }}
              >
                Delete
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
