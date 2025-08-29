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

type EquipmentStatus = "AVAILABLE" | "CHECKED_OUT" | "MAINTENANCE" | "RETIRED";
type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: EquipmentStatus;
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

  const myIds = useMemo(() => new Set(mine.map((m) => m.id)), [mine]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, mineList] = await Promise.all([
        apiGet<Equipment[]>("/api/v1/equipment"),
        apiGet<Equipment[]>("/api/v1/equipment/mine"),
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

  async function checkout(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/equipment/${id}/claim`);
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
      await apiPost(`/api/v1/equipment/${id}/release`);
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
        Equipment
      </Heading>

      <Stack gap="3">
        {loading && <LoadingCenter />}

        {!loading && items.length === 0 && <Text>No equipment.</Text>}

        {!loading &&
          items.map((item) => {
            const isMine = myIds.has(item.id);
            const canReturnMine = item.status === "CHECKED_OUT" && isMine;
            const canCheckout = item.status === "AVAILABLE";

            let label = "Checkout";
            let onClick: (() => void) | undefined;
            let enabled = false;

            if (canReturnMine) {
              label = "Return";
              onClick = () => void returnItem(item.id);
              enabled = true;
            } else if (canCheckout) {
              label = "Checkout";
              onClick = () => void checkout(item.id);
              enabled = true;
            } else {
              label = "Checkout"; // disabled for maintenance or someone else's checkout
              enabled = false;
            }

            return (
              <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
                <Heading size="sm">
                  {item.shortDesc}{" "}
                  <Badge ml={2}>
                    {item.status === "AVAILABLE"
                      ? "Available"
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
                  <Button
                    onClick={onClick}
                    disabled={!!busyId || !enabled}
                    loading={busyId === item.id}
                  >
                    {label}
                  </Button>
                </Stack>
              </Box>
            );
          })}
      </Stack>
    </Box>
  );
}
