import { useEffect, useMemo, useState } from "react";
import { Box, Button, Heading, Stack, Text, Badge } from "@chakra-ui/react";
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

export default function WorkerEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [mine, setMine] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const myIds = useMemo(() => new Set(mine.map((m) => m.id)), [mine]);

  async function refresh() {
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
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function claim(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/equipment/${id}/claim`);
      toaster.success({ title: "Claimed" });
      await refresh();
    } catch (err) {
      toaster.error({
        title: "Could not claim",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function release(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/equipment/${id}/release`);
      toaster.success({ title: "Released" });
      await refresh();
    } catch (err) {
      toaster.error({
        title: "Could not release",
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
        {loading && <Text>Loading…</Text>}
        {!loading && items.length === 0 && <Text>No equipment.</Text>}
        {!loading &&
          items.map((item) => {
            const isMine = myIds.has(item.id);
            const canReleaseMine = item.status === "CHECKED_OUT" && isMine;
            const canClaim = item.status === "AVAILABLE";

            // Single button that swaps Claim <-> Release
            let label = "Claim";
            let onClick: (() => void) | undefined;
            let enabled = false;

            if (canReleaseMine) {
              label = "Release";
              onClick = () => void release(item.id);
              enabled = true;
            } else if (canClaim) {
              label = "Claim";
              onClick = () => void claim(item.id);
              enabled = true;
            } else {
              label = "Claim"; // disabled for MAINTENANCE or checked out by someone else
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
