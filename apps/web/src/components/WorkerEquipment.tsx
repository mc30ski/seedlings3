import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Box,
  Button,
  Heading,
  Stack,
  Text,
  Badge,
  Spinner,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "../lib/api";
import { toaster } from "./ui/toaster";
import { getErrorMessage } from "../lib/errors";

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

export default function WorkerEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [mine, setMine] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // myIds includes RESERVED or CHECKED_OUT that belong to me
  const myIds = useMemo(() => new Set(mine.map((m) => m.id)), [mine]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, mineList] = await Promise.all([
        apiGet<Equipment[]>("/api/equipment"),
        apiGet<Equipment[]>("/api/equipment/mine"),
      ]);
      setItems(all);
      setMine(mineList);
    } catch (err) {
      toaster.error({
        title: "Failed to load equipment",
        description: getErrorMessage(err),
      });
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

  async function reserve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/reserve`);
      toaster.success({ title: "Reserved" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Could not reserve",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function cancelReserve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/reserve/cancel`);
      toaster.info({ title: "Reservation canceled" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Could not cancel reservation",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function checkout(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/checkout`);
      toaster.success({ title: "Checked out" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Could not check out",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function returnItem(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/return`);
      toaster.success({ title: "Returned" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Could not return",
        description: getErrorMessage(err),
      });
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

            // Button set based on state
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
                // Reserved by someone else — no action
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
              // MAINTENANCE / RETIRED
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
