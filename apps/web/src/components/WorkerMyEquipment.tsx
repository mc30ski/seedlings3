// apps/web/src/components/WorkerMyEquipment.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  HStack,
  Stack,
  Text,
  Badge,
  Button,
  Spinner,
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
  brand?: string | null;
  model?: string | null;
  status: EquipmentStatus;
};

const statusColor: Record<EquipmentStatus, any> = {
  AVAILABLE: { colorPalette: "green" },
  RESERVED: { colorPalette: "yellow" },
  CHECKED_OUT: { colorPalette: "blue" },
  MAINTENANCE: { colorPalette: "orange" },
  RETIRED: { colorPalette: "gray" },
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

function errorMessage(err: any): string {
  return (
    err?.message ||
    err?.data?.message ||
    err?.response?.data?.message ||
    "Action failed"
  );
}

// Shared update signal
function notifyEquipmentUpdated() {
  try {
    window.dispatchEvent(new CustomEvent("seedlings3:equipment-updated"));
  } catch {}
}

export default function WorkerMyEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Inline warning per equipment id
  const [inlineWarn, setInlineWarn] = useState<Record<string, string>>({});

  const myIds = useMemo(() => new Set(items.map((m) => m.id)), [items]);

  const dismissInline = (id: string) =>
    setInlineWarn((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const mineList = await apiGet<Equipment[]>("/api/equipment/mine");
      setItems(mineList);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUpd = () => void refresh();
    window.addEventListener("seedlings3:equipment-updated", onUpd);
    return () =>
      window.removeEventListener("seedlings3:equipment-updated", onUpd);
  }, [refresh]);

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

  return (
    <Box>
      <Heading size="md" mb={4}>
        Equipment I&apos;ve Claimed
      </Heading>

      <Stack gap="3">
        {loading && <LoadingCenter />}

        {!loading && items.length === 0 && <Text>No equipment.</Text>}

        {!loading &&
          items.map((item) => {
            const chip =
              item.status === "AVAILABLE"
                ? "Available"
                : item.status === "RESERVED"
                  ? myIds.has(item.id)
                    ? "Reserved (You)"
                    : "Reserved"
                  : item.status === "CHECKED_OUT"
                    ? myIds.has(item.id)
                      ? "Checked out (You)"
                      : "Checked out"
                    : item.status === "MAINTENANCE"
                      ? "Maintenance"
                      : "Retired";

            return (
              <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
                <Heading size="sm">
                  {item.brand ? `${item.brand} ` : ""}
                  {item.model ? `${item.model} ` : ""}({item.shortDesc})
                  <Badge ml={2} {...statusColor[item.status]}>
                    {chip}
                  </Badge>
                </Heading>
                <Text fontSize="sm" color="gray.500">
                  {item.longDesc}
                </Text>

                {/* Inline warning banner */}
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
                  {item.status === "RESERVED" ? (
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
                  ) : item.status === "CHECKED_OUT" ? (
                    <Button
                      onClick={() => void returnItem(item.id)}
                      disabled={!!busyId}
                      loading={busyId === item.id}
                    >
                      Return
                    </Button>
                  ) : (
                    <Button disabled>Not actionable</Button>
                  )}
                </Stack>
              </Box>
            );
          })}
      </Stack>
    </Box>
  );
}
