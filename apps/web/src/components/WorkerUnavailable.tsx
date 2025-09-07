// apps/web/src/components/WorkerUnavailable.tsx
import { useEffect, useState, useCallback } from "react";
import {
  Box,
  Badge,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { apiGet } from "../lib/api";
import { toaster } from "./ui/toaster";
import { getErrorMessage } from "../lib/errors";

type EquipmentStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "CHECKED_OUT"
  | "MAINTENANCE"
  | "RETIRED";

type Holder = {
  userId: string;
  displayName: string | null;
  email: string | null;
  reservedAt: string; // ISO from API
  checkedOutAt: string | null;
  state: "RESERVED" | "CHECKED_OUT";
};

type Item = {
  id: string;
  shortDesc: string;
  longDesc?: string | null;
  status: "MAINTENANCE" | "RESERVED" | "CHECKED_OUT" | "AVAILABLE" | "RETIRED";
  holder: Holder | null;
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

const statusColor: Record<EquipmentStatus, any> = {
  AVAILABLE: { colorPalette: "green" },
  RESERVED: { colorPalette: "orange" },
  CHECKED_OUT: { colorPalette: "red" },
  MAINTENANCE: { colorPalette: "yellow" },
  RETIRED: { colorPalette: "gray" },
};

export default function WorkerUnavailable() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Item[]>("/api/v1/equipment/unavailable");
      setItems(data);
    } catch (err) {
      toaster.error({
        title: "Failed to load unavailable equipment",
        description: getErrorMessage(err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingCenter />;

  if (!loading && items.length === 0)
    return <Text>No unavailable equipment right now.</Text>;

  return (
    <Stack gap="3">
      {items.map((item) => (
        <Box key={item.id} p={3} borderWidth="1px" borderRadius="md">
          <HStack justify="space-between" align="start">
            <Box>
              <Heading size="sm">
                {item.shortDesc}{" "}
                <Badge ml={2} {...statusColor[item.status]}>
                  {item.status === "AVAILABLE"
                    ? "Available"
                    : item.status === "RESERVED"
                      ? "Reserved"
                      : item.status === "CHECKED_OUT"
                        ? "Checked out"
                        : item.status === "MAINTENANCE"
                          ? "Maintenance"
                          : "Retired"}
                </Badge>
              </Heading>

              {/* holder line when reserved/checked out */}
              {item.holder && (
                <Text fontSize="xs" color="gray.600" mt={1}>
                  {item.holder.state === "CHECKED_OUT"
                    ? "Checked out by "
                    : "Reserved by "}
                  {item.holder.displayName ||
                    item.holder.email ||
                    item.holder.userId.slice(0, 8)}
                </Text>
              )}

              {/* long description (optional) */}
              {item.longDesc ? (
                <Text fontSize="sm" color="gray.500" mt={1}>
                  {item.longDesc}
                </Text>
              ) : null}
            </Box>
          </HStack>
        </Box>
      ))}
    </Stack>
  );
}
