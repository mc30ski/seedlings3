import { useEffect, useState, useCallback } from "react";
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
    window.dispatchEvent(new Event("seedlings3:equipment-updated"));
  }
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

export default function WorkerMyEquipment() {
  const [mine, setMine] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const mineList = await apiGet<Equipment[]>("/api/equipment/mine");
      setMine(mineList);
    } catch (err) {
      toaster.error({
        title: "Failed to load my equipment",
        description: getErrorMessage(err),
      });
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

  async function checkout(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/equipment/${id}/checkout`);
      toaster.success({ title: "Checked out" });
      notifyEquipmentUpdated();
      await refresh();
    } catch (err) {
      toaster.error({
        title: "Could not check out",
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
      await refresh();
    } catch (err) {
      toaster.error({
        title: "Could not cancel",
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
      await refresh();
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
        Equipment I've Claimed
      </Heading>

      <Stack gap="3">
        {loading && <LoadingCenter />}

        {!loading && mine.length === 0 && (
          <Text>You don’t have anything reserved or checked out.</Text>
        )}

        {!loading &&
          mine.map((item) => {
            const chips =
              item.status === "RESERVED"
                ? "Reserved (You)"
                : item.status === "CHECKED_OUT"
                  ? "Checked out (You)"
                  : item.status;

            return (
              <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
                <Heading size="sm">
                  {item.shortDesc}{" "}
                  <Badge ml={2} {...statusColor[item.status]}>
                    {chips}
                  </Badge>
                </Heading>
                <Text fontSize="sm" color="gray.500">
                  {item.longDesc}
                </Text>

                <Stack direction="row" gap="2" mt={2}>
                  {item.status === "RESERVED" && (
                    <>
                      <Button
                        onClick={() => void checkout(item.id)}
                        disabled={!!busyId}
                        loading={busyId === item.id}
                      >
                        Checkout
                      </Button>
                      <Button
                        onClick={() => void cancelReserve(item.id)}
                        disabled={!!busyId}
                        loading={busyId === item.id}
                        variant="outline"
                      >
                        Cancel Reservation
                      </Button>
                    </>
                  )}
                  {item.status === "CHECKED_OUT" && (
                    <Button
                      onClick={() => void returnItem(item.id)}
                      disabled={!!busyId}
                      loading={busyId === item.id}
                    >
                      Return
                    </Button>
                  )}
                </Stack>
              </Box>
            );
          })}
      </Stack>
    </Box>
  );
}
