// apps/web/src/components/WorkerAll.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Badge,
  Button,
  Input,
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
  qrSlug: string | null;
  status: EquipmentStatus;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
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

// Pretty-print status like other tabs: "Available", "Checked out", etc.
function prettyStatus(s: EquipmentStatus): string {
  const lower = s.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default function WorkerAll() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const [status, setStatus] = useState<
    "all" | "available" | "reserved" | "checked_out" | "maintenance" | "retired"
  >("all");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, meResp] = await Promise.all([
        apiGet<Equipment[]>("/api/equipment/all"),
        apiGet<Me>("/api/me"),
      ]);
      setItems(data);
      setMe(meResp);
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

  const filtered = useMemo(() => {
    let rows = items;

    if (status !== "all") {
      let want: EquipmentStatus[] | null = null;
      switch (status) {
        case "available":
          want = ["AVAILABLE"];
          break;
        case "reserved":
          want = ["RESERVED"];
          break;
        case "checked_out":
          want = ["CHECKED_OUT"];
          break;
        case "maintenance":
          want = ["MAINTENANCE"];
          break;
        case "retired":
          want = ["RETIRED"];
          break;
      }
      if (want) rows = rows.filter((r) => want!.includes(r.status));
    }

    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const s = (r.shortDesc || "").toLowerCase();
        const l = (r.longDesc || "").toLowerCase();
        const who =
          r.holder?.displayName?.toLowerCase() ||
          r.holder?.email?.toLowerCase() ||
          "";
        return s.includes(qlc) || l.includes(qlc) || who.includes(qlc);
      });
    }

    return rows;
  }, [items, status, q]);

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
        All Equipment
      </Heading>

      {/* Filters (buttons wrap on mobile) */}
      <Stack
        direction={{ base: "column", md: "row" }}
        gap="2"
        align={{ base: "stretch", md: "center" }}
        mb={3}
      >
        <Box display="flex" flexWrap="wrap" gap="6px">
          {(
            [
              ["all", "All"],
              ["available", "Available"],
              ["reserved", "Reserved"],
              ["checked_out", "Checked out"],
              ["maintenance", "Maintenance"],
              ["retired", "Retired"],
            ] as const
          ).map(([val, label]) => (
            <Button
              key={val}
              size="sm"
              variant={status === val ? "solid" : "outline"}
              onClick={() => setStatus(val)}
            >
              {label}
            </Button>
          ))}
        </Box>

        <Input
          placeholder="Search description / holder…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          w={{ base: "100%", md: "320px" }}
        />
      </Stack>

      {/* Separator */}
      <Box h="1px" bg="gray.200" mb={3} />

      {filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}

      {filtered.map((item) => {
        const isMine = !!me && !!item.holder && item.holder.userId === me.id;
        return (
          <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg" mb={3}>
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
    </Box>
  );
}
