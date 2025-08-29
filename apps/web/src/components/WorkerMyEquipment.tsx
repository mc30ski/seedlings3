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

type EquipmentStatus = "AVAILABLE" | "CHECKED_OUT" | "MAINTENANCE" | "RETIRED";
type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: EquipmentStatus;
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
      const mineList = await apiGet<Equipment[]>("/api/v1/equipment/mine");
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

  async function returnItem(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/equipment/${id}/release`);
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
        My Equipment
      </Heading>

      <Stack gap="3">
        {loading && <LoadingCenter />}

        {!loading && mine.length === 0 && (
          <Text>You don’t have anything checked out.</Text>
        )}

        {!loading &&
          mine.map((item) => (
            <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
              <Heading size="sm">
                {item.shortDesc} <Badge ml={2}>Checked out (You)</Badge>
              </Heading>
              <Text fontSize="sm" color="gray.500">
                {item.longDesc}
              </Text>

              <Stack direction="row" gap="2" mt={2}>
                <Button
                  onClick={() => void returnItem(item.id)}
                  disabled={!!busyId}
                  loading={busyId === item.id}
                >
                  Return
                </Button>
              </Stack>
            </Box>
          ))}
      </Stack>
    </Box>
  );
}
