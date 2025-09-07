// apps/web/src/components/AdminEquipment.tsx
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
import { apiGet, apiPost, apiDelete } from "../lib/api";
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
  reservedAt: string;
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
  holder: Holder | null;
};

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

export default function AdminEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);

  // create form state
  const [creating, setCreating] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newQr, setNewQr] = useState("");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<
    "all" | "available" | "reserved" | "checked_out" | "maintenance" | "retired"
  >("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Equipment[]>("/api/v1/admin/equipment");
      setItems(data);
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
  }, [items, q, status]);

  // ---- create ----
  async function createEquipment() {
    const shortDesc = newShort.trim();
    const longDesc = newLong.trim();
    const qrSlug = newQr.trim();
    if (!shortDesc) {
      toaster.error({ title: "Short description is required" });
      return;
    }
    setCreating(true);
    try {
      await apiPost("/api/v1/admin/equipment", {
        shortDesc,
        longDesc: longDesc || undefined,
        qrSlug: qrSlug || undefined,
      });
      toaster.success({ title: "Equipment created" });
      setNewShort("");
      setNewLong("");
      setNewQr("");
      await load();
    } catch (err) {
      toaster.error({
        title: "Create failed",
        description: getErrorMessage(err),
      });
    } finally {
      setCreating(false);
    }
  }

  // ---- actions ----
  async function forceRelease(id: string) {
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/release`, {});
      toaster.success({ title: "Released" });
      await load();
    } catch (err) {
      toaster.error({
        title: "Release failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function startMaint(id: string) {
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/maintenance/start`, {});
      toaster.success({ title: "Maintenance started" });
      await load();
    } catch (err) {
      toaster.error({
        title: "Start maintenance failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function endMaint(id: string) {
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/maintenance/end`, {});
      toaster.success({ title: "Maintenance ended" });
      await load();
    } catch (err) {
      toaster.error({
        title: "End maintenance failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function retire(id: string) {
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/retire`, {});
      toaster.success({ title: "Retired" });
      await load();
    } catch (err) {
      toaster.error({
        title: "Retire failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function unretire(id: string) {
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/unretire`, {});
      toaster.success({ title: "Unretired" });
      await load();
    } catch (err) {
      toaster.error({
        title: "Unretire failed",
        description: getErrorMessage(err),
      });
    }
  }

  async function hardDelete(id: string) {
    try {
      await apiDelete(`/api/v1/admin/equipment/${id}`);
      toaster.success({ title: "Deleted" });
      await load();
    } catch (err) {
      toaster.error({
        title: "Delete failed",
        description: getErrorMessage(err),
      });
    }
  }

  // ---- guards for showing buttons ----
  const canForceRelease = (e: Equipment) => !!e.holder;
  const canStartMaint = (e: Equipment) =>
    e.status !== "RETIRED" && e.status !== "MAINTENANCE" && !e.holder;
  const canEndMaint = (e: Equipment) => e.status === "MAINTENANCE";
  const canRetire = (e: Equipment) =>
    e.status !== "RETIRED" &&
    !e.holder &&
    e.status !== "RESERVED" &&
    e.status !== "CHECKED_OUT";
  const canUnretire = (e: Equipment) => e.status === "RETIRED";
  const canDelete = (e: Equipment) => e.status === "RETIRED";

  const statusColor: Record<EquipmentStatus, any> = {
    AVAILABLE: { colorPalette: "green" },
    RESERVED: { colorPalette: "orange" },
    CHECKED_OUT: { colorPalette: "red" },
    MAINTENANCE: { colorPalette: "yellow" },
    RETIRED: { colorPalette: "gray" },
  };

  return (
    <Box w="full">
      <Heading size="md" mb={4}>
        Equipment (Admin)
      </Heading>

      {/* Create panel */}
      <Box
        w="full"
        mb={4}
        p={3}
        borderWidth="1px"
        borderRadius="lg"
        bg="gray.50"
      >
        <Stack
          direction={{ base: "column", md: "row" }}
          gap="2"
          align={{ base: "stretch", md: "end" }}
        >
          <Input
            placeholder="Short description *"
            value={newShort}
            onChange={(e) => setNewShort(e.target.value)}
          />
          <Input
            placeholder="Details (optional)"
            value={newLong}
            onChange={(e) => setNewLong(e.target.value)}
          />
          <Input
            placeholder="QR slug (optional)"
            value={newQr}
            onChange={(e) => setNewQr(e.target.value)}
          />
          <Button
            onClick={createEquipment}
            loading={creating}
            disabled={creating || !newShort.trim()}
            size={{ base: "sm", md: "sm" }}
          >
            Create
          </Button>
        </Stack>
      </Box>

      {/* Filters */}
      <Stack
        direction={{ base: "column", md: "row" }}
        gap="2"
        wrap="wrap"
        mb={3}
        w="full"
      >
        <HStack gap="1" flexWrap="wrap">
          <Button
            size={{ base: "xs", md: "sm" }}
            variant={status === "all" ? "solid" : "outline"}
            onClick={() => setStatus("all")}
          >
            All
          </Button>
          <Button
            size={{ base: "xs", md: "sm" }}
            variant={status === "available" ? "solid" : "outline"}
            onClick={() => setStatus("available")}
          >
            Available
          </Button>
          <Button
            size={{ base: "xs", md: "sm" }}
            variant={status === "reserved" ? "solid" : "outline"}
            onClick={() => setStatus("reserved")}
          >
            Reserved
          </Button>
          <Button
            size={{ base: "xs", md: "sm" }}
            variant={status === "checked_out" ? "solid" : "outline"}
            onClick={() => setStatus("checked_out")}
          >
            Checked out
          </Button>
          <Button
            size={{ base: "xs", md: "sm" }}
            variant={status === "maintenance" ? "solid" : "outline"}
            onClick={() => setStatus("maintenance")}
          >
            Maintenance
          </Button>
          <Button
            size={{ base: "xs", md: "sm" }}
            variant={status === "retired" ? "solid" : "outline"}
            onClick={() => setStatus("retired")}
          >
            Retired
          </Button>
        </HStack>

        <Input
          placeholder="Search description / holder…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxW={{ base: "full", md: "320px" }}
          ml={{ base: 0, md: "auto" }}
        />
      </Stack>

      <Box h="1px" bg="gray.200" mb={3} />

      {loading && <LoadingCenter />}

      {!loading && filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}

      {!loading &&
        filtered.map((item) => (
          <Box
            key={item.id}
            p={3}
            borderWidth="1px"
            borderRadius="lg"
            mb={3}
            w="full"
          >
            <Stack
              direction={{ base: "column", md: "row" }}
              align={{ base: "stretch", md: "start" }}
              justify="space-between"
              gap="3"
              w="full"
            >
              <Box flex="1 1 0" minW={0}>
                <Heading size={{ base: "sm", md: "sm" }} wordBreak="break-word">
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

              <Stack
                direction="row"
                gap="2"
                flexWrap="wrap"
                justify={{ base: "flex-start", md: "flex-end" }}
              >
                {canForceRelease(item) && (
                  <Button
                    size={{ base: "xs", md: "sm" }}
                    onClick={() => forceRelease(item.id)}
                  >
                    Force release
                  </Button>
                )}
                {canStartMaint(item) && (
                  <Button
                    size={{ base: "xs", md: "sm" }}
                    variant="subtle"
                    onClick={() => startMaint(item.id)}
                  >
                    Start maintenance
                  </Button>
                )}
                {canEndMaint(item) && (
                  <Button
                    size={{ base: "xs", md: "sm" }}
                    variant="subtle"
                    onClick={() => endMaint(item.id)}
                  >
                    End maintenance
                  </Button>
                )}
                {canRetire(item) && (
                  <Button
                    size={{ base: "xs", md: "sm" }}
                    variant="outline"
                    onClick={() => retire(item.id)}
                  >
                    Retire
                  </Button>
                )}
                {canUnretire(item) && (
                  <Button
                    size={{ base: "xs", md: "sm" }}
                    variant="outline"
                    onClick={() => unretire(item.id)}
                  >
                    Unretire
                  </Button>
                )}
                {canDelete(item) && (
                  <Button
                    size={{ base: "xs", md: "sm" }}
                    variant="outline"
                    onClick={() => hardDelete(item.id)}
                  >
                    Delete
                  </Button>
                )}
              </Stack>
            </Stack>
          </Box>
        ))}
    </Box>
  );
}
