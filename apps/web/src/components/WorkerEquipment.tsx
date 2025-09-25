// apps/web/src/components/WorkerEquipment.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Box,
  Button,
  Heading,
  Stack,
  Text,
  Badge,
  Spinner,
  HStack,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "../lib/api";

type EquipmentStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "CHECKED_OUT"
  | "MAINTENANCE"
  | "RETIRED";

type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: EquipmentStatus;
};

const statusColor: Record<EquipmentStatus, any> = {
  AVAILABLE: { colorPalette: "green" },
  RESERVED: { colorPalette: "orange" },
  CHECKED_OUT: { colorPalette: "red" },
  MAINTENANCE: { colorPalette: "yellow" },
  RETIRED: { colorPalette: "gray" },
};

const notifyEquipmentUpdated = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("seedlings3:equipment-updated"));
  }
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

function errorMessage(err: any): string {
  // Try common shapes from your fetch wrapper / API
  return (
    err?.message ||
    err?.data?.message ||
    err?.response?.data?.message ||
    "Action failed"
  );
}

export default function WorkerEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [mine, setMine] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});

  const myIds = useMemo(() => new Set(mine.map((m) => m.id)), [mine]);

  const dismissInline = (id: string) =>
    setInlineWarn((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, mineList] = await Promise.all([
        apiGet<Equipment[]>("/api/equipment"),
        apiGet<Equipment[]>("/api/equipment/mine"),
      ]);
      setItems(all);
      setMine(mineList);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUpd = () => void load();
    window.addEventListener("seedlings3:equipment-updated", onUpd);
    return () =>
      window.removeEventListener("seedlings3:equipment-updated", onUpd);
  }, [load]);

  function captureInlineConflict(id: string, err: any) {
    const status =
      err?.status ?? err?.httpStatus ?? err?.response?.status ?? undefined;

    // Show inline warning for any client/server error. Conflict-like codes get the API message.
    if (status && status >= 400) {
      setInlineWarn((m) => ({
        ...m,
        [id]: errorMessage(err),
      }));
    } else {
      // If we can't read status, still surface something inline.
      setInlineWarn((m) => ({
        ...m,
        [id]: errorMessage(err),
      }));
    }
    // No toasts by design.
  }

  async function reserve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/reserve`);
      dismissInline(id);
      notifyEquipmentUpdated();
      await load();
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
      await load();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  async function checkout(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/checkout`);
      dismissInline(id);
      notifyEquipmentUpdated();
      await load();
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
      await load();
    } catch (err: any) {
      captureInlineConflict(id, err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Box>
      <Heading size="md" mb={4}>
        Equipment Available
      </Heading>

      <Stack gap="3">
        {loading && <LoadingCenter />}

        {!loading && items.length === 0 && <Text>No equipment.</Text>}

        {!loading &&
          items.map((item) => {
            const isMine = myIds.has(item.id);

            const actions: JSX.Element[] = [];

            if (item.status === "AVAILABLE") {
              actions.push(
                <Button
                  key="reserve"
                  onClick={() => void reserve(item.id)}
                  disabled={!!busyId}
                  loading={busyId === item.id}
                >
                  Reserve
                </Button>
              );
            } else if (item.status === "RESERVED") {
              if (isMine) {
                actions.push(
                  <Button
                    key="checkout"
                    onClick={() => void checkout(item.id)}
                    disabled={!!busyId}
                    loading={busyId === item.id}
                  >
                    Checkout
                  </Button>
                );
                actions.push(
                  <Button
                    key="cancel"
                    onClick={() => void cancelReserve(item.id)}
                    disabled={!!busyId}
                    loading={busyId === item.id}
                    variant="outline"
                  >
                    Cancel Reservation
                  </Button>
                );
              } else {
                actions.push(
                  <Button key="reserved" disabled>
                    Reserved
                  </Button>
                );
              }
            } else if (item.status === "CHECKED_OUT") {
              if (isMine) {
                actions.push(
                  <Button
                    key="return"
                    onClick={() => void returnItem(item.id)}
                    disabled={!!busyId}
                    loading={busyId === item.id}
                  >
                    Return
                  </Button>
                );
              } else {
                actions.push(
                  <Button key="checked" disabled>
                    Checked out
                  </Button>
                );
              }
            } else {
              actions.push(
                <Button key="na" disabled>
                  {item.status === "MAINTENANCE" ? "Maintenance" : "Retired"}
                </Button>
              );
            }

            return (
              <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
                <Heading size="sm">
                  {item.shortDesc}{" "}
                  <Badge ml={2} {...statusColor[item.status]}>
                    {item.status === "AVAILABLE"
                      ? "Available"
                      : item.status === "RESERVED"
                        ? isMine
                          ? "Reserved (You)"
                          : "Reserved"
                        : item.status === "CHECKED_OUT"
                          ? isMine
                            ? "Checked out (You)"
                            : "Checked out"
                          : item.status === "MAINTENANCE"
                            ? "Maintenance"
                            : "Retired"}
                  </Badge>
                </Heading>
                <Text fontSize="sm" color="gray.500">
                  {item.longDesc}
                </Text>

                {/* Inline warning banner for this item */}
                {inlineWarn[item.id] && (
                  <HStack
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
                      onClick={() => dismissInline(item.id)}
                    >
                      Dismiss
                    </Button>
                  </HStack>
                )}

                <Stack direction="row" gap="2" mt={2}>
                  {actions}
                </Stack>
              </Box>
            );
          })}
      </Stack>
    </Box>
  );
}
