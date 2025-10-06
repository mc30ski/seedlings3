import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Badge,
  Button,
} from "@chakra-ui/react";
import { useState } from "react";
import { Equipment, EquipmentStatus } from "../../lib/types";
import { apiPost } from "../../lib/api";

// Shared update signal
function notifyEquipmentUpdated() {
  try {
    window.dispatchEvent(new CustomEvent("seedlings3:equipment-updated"));
  } catch {}
}

function errorMessage(err: any): string {
  return (
    err?.message ||
    err?.data?.message ||
    err?.response?.data?.message ||
    "Action failed"
  );
}

// Pretty-print status like other tabs: "Available", "Checked out", etc.
function prettyStatus(s: EquipmentStatus): string {
  const lower = s.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const statusColor: Record<EquipmentStatus, any> = {
  AVAILABLE: { colorPalette: "green" },
  RESERVED: { colorPalette: "orange" },
  CHECKED_OUT: { colorPalette: "red" },
  MAINTENANCE: { colorPalette: "yellow" },
  RETIRED: { colorPalette: "gray" },
};

type EquipmentTileProps = {
  item: Equipment;
  isMine: boolean;
  filter: string;
  refresh: any;
};

export default function EquipmentTile({
  item,
  isMine,
  filter,
  refresh,
}: EquipmentTileProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});

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

  async function checkout(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/checkout`);
      dismissInline(id);
      notifyEquipmentUpdated();
      await refresh();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  async function reserve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/reserve`);
      dismissInline(id);
      notifyEquipmentUpdated();
      await refresh();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  async function cancelReserve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/reserve/cancel`);
      dismissInline(id);
      notifyEquipmentUpdated();
      await refresh();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  async function returnItem(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/return`);
      dismissInline(id);
      notifyEquipmentUpdated();
      await refresh();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
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

  return (
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
          <Heading size="sm">
            {item.brand ? `${item.brand} ` : ""}
            {item.model ? `${item.model} ` : ""}
            <Badge ml={2} {...statusColor[item.status]}>
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
            {filter === "claimed" && item.status === "RESERVED" ? (
              <>
                <Button
                  onClick={() => void checkout(item.id)}
                  disabled={!!busyId}
                  loading={busyId === item.id}
                >
                  Check Out
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void cancelReserve(item.id)}
                  disabled={!!busyId}
                  loading={busyId === item.id}
                >
                  Cancel Reservation
                </Button>
              </>
            ) : filter === "claimed" && item.status === "CHECKED_OUT" ? (
              <Button
                onClick={() => void returnItem(item.id)}
                disabled={!!busyId}
                loading={busyId === item.id}
              >
                Return
              </Button>
            ) : filter === "available" && item.status === "AVAILABLE" ? (
              <Button
                key="reserve"
                onClick={() => void reserve(item.id)}
                disabled={!!busyId}
                loading={busyId === item.id}
              >
                Reserve
              </Button>
            ) : null}
          </Stack>
        </Box>
      </HStack>
    </Box>
  );
}
