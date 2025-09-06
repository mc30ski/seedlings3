import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  HStack,
  Stack,
  Text,
  Badge,
  Input,
  Spinner,
} from "@chakra-ui/react";
import { apiGet } from "../lib/api";

type Status =
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

type EquipmentRow = {
  id: string;
  shortDesc: string;
  longDesc?: string | null;
  qrSlug?: string | null;
  status: Status;
  createdAt?: string;
  updatedAt?: string;
  holder: Holder | null;
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

function fmtWhen(holder: Holder) {
  if (holder.state === "CHECKED_OUT" && holder.checkedOutAt) {
    return new Date(holder.checkedOutAt).toLocaleString();
  }
  return new Date(holder.reservedAt).toLocaleString();
}

function statusBadgeProps(
  status: Status
): { colorPalette?: string } | Record<string, never> {
  switch (status) {
    case "AVAILABLE":
      return { colorPalette: "green" };
    case "RESERVED":
      return { colorPalette: "orange" };
    case "CHECKED_OUT":
      return { colorPalette: "purple" };
    case "MAINTENANCE":
      return { colorPalette: "yellow" };
    case "RETIRED":
      return { colorPalette: "gray" };
    default:
      return {};
  }
}

export default function AdminEquipment() {
  const [items, setItems] = useState<EquipmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // richer shape including "holder"
      const data = await apiGet<EquipmentRow[]>(
        "/api/v1/admin/equipment/with-holders"
      );
      setItems(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const qlc = q.trim().toLowerCase();
    if (!qlc) return items;
    return items.filter((e) => {
      const s =
        `${e.shortDesc} ${e.longDesc ?? ""} ${e.qrSlug ?? ""}`.toLowerCase();
      return s.includes(qlc);
    });
  }, [items, q]);

  return (
    <Box>
      <Heading size="md" mb={4}>
        Equipment
      </Heading>

      {/* Search */}
      <HStack mb={3}>
        <Input
          placeholder="Search equipment…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxW="360px"
        />
      </HStack>

      {loading && <LoadingCenter />}

      {!loading && filtered.length === 0 && <Text>No equipment found.</Text>}

      {!loading &&
        filtered.map((e) => {
          const holder = e.holder;

          return (
            <Box
              key={e.id}
              p={3}
              borderWidth="1px"
              borderRadius="lg"
              mb={2}
              bg="white"
            >
              <HStack justify="space-between" align="start">
                <Box>
                  <HStack gap="2" wrap="wrap">
                    <Heading size="sm">{e.shortDesc}</Heading>
                    <Badge {...statusBadgeProps(e.status)}>{e.status}</Badge>
                    {e.qrSlug ? (
                      <Badge colorPalette="blue">QR: {e.qrSlug}</Badge>
                    ) : null}
                  </HStack>

                  {e.longDesc ? (
                    <Text mt={1} fontSize="sm" color="gray.700">
                      {e.longDesc}
                    </Text>
                  ) : null}

                  {/* Holder chip — mirrors Admin Users “holdings” look/feel */}
                  {holder && (
                    <HStack
                      mt={2}
                      gap="2"
                      wrap="wrap"
                      // chip/Pill look
                    >
                      <HStack
                        px={2}
                        py={1}
                        borderRadius="md"
                        borderWidth="1px"
                        borderColor="gray.200"
                        bg="gray.50"
                        gap="2"
                      >
                        <Badge
                          size="sm"
                          colorPalette={
                            holder.state === "CHECKED_OUT" ? "purple" : "orange"
                          }
                        >
                          {holder.state === "CHECKED_OUT"
                            ? "Checked out"
                            : "Reserved"}
                        </Badge>
                        <Text fontSize="sm">
                          {holder.displayName ||
                            holder.email ||
                            `User ${holder.userId.slice(0, 8)}…`}
                        </Text>
                        <Text fontSize="xs" color="gray.600">
                          since {fmtWhen(holder)}
                        </Text>
                      </HStack>
                    </HStack>
                  )}
                </Box>

                {/* Right side: small meta */}
                <Stack align="end" gap="1">
                  <Text fontSize="xs" color="gray.600">
                    id: {e.id.slice(0, 8)}…
                  </Text>
                </Stack>
              </HStack>
            </Box>
          );
        })}
    </Box>
  );
}
