// apps/web/src/components/WorkerUnavailable.tsx
import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Badge,
  Spinner,
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
  reservedAt: string; // ISO
  checkedOutAt: string | null;
  state: "RESERVED" | "CHECKED_OUT";
};

type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string | null;
  status: EquipmentStatus;
  brand?: string | null;
  model?: string | null;
  holder: Holder | null;
};

type Me = { id: string; email: string | null; displayName: string | null };

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

function prettyStatus(s: EquipmentStatus): string {
  const lower = s.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default function WorkerUnavailable() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, meResp] = await Promise.all([
        apiGet<Equipment[]>("/api/equipment/unavailable"),
        apiGet<Me>("/api/me"),
      ]);
      setItems(data);
      setMe(meResp);
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

  const statusColor: Record<EquipmentStatus, any> = {
    AVAILABLE: { colorPalette: "green" },
    RESERVED: { colorPalette: "orange" },
    CHECKED_OUT: { colorPalette: "red" },
    MAINTENANCE: { colorPalette: "yellow" },
    RETIRED: { colorPalette: "gray" },
  };

  if (loading) return <LoadingCenter />;

  return (
    <Box>
      <Heading size="md" mb={3}>
        Unavailable Equipment
      </Heading>

      {items.length === 0 && <Text>No unavailable equipment.</Text>}

      <Stack gap="3">
        {items.map((item) => {
          const isMine = !!me && !!item.holder && item.holder.userId === me.id;
          return (
            <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
              <HStack justify="space-between" align="start">
                <Box>
                  <Heading size="sm">
                    {item.brand ? `${item.brand} ` : ""}
                    {item.model ? `${item.model} ` : ""}({item.shortDesc})
                    <Badge ml={2} {...statusColor[item.status]}>
                      {prettyStatus(item.status)}
                      {isMine &&
                      (item.status === "RESERVED" ||
                        item.status === "CHECKED_OUT")
                        ? " (You)"
                        : ""}
                    </Badge>
                  </Heading>

                  {item.holder && (
                    <Text fontSize="xs" color="gray.700" mt={1}>
                      {item.holder.state === "CHECKED_OUT"
                        ? "Checked out by "
                        : "Reserved by "}
                      {item.holder.displayName ||
                        item.holder.email ||
                        item.holder.userId.slice(0, 8)}
                    </Text>
                  )}

                  {item.longDesc && (
                    <Text fontSize="sm" color="gray.600" mt={1}>
                      {item.longDesc}
                    </Text>
                  )}
                </Box>
              </HStack>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
