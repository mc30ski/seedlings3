import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Box,
  Button,
  Heading,
  Stack,
  Text,
  Input,
  Badge,
  Spinner,
  HStack,
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

type HolderInfo = {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  state: "RESERVED" | "CHECKED_OUT";
};

type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: EquipmentStatus;
  holder?: HolderInfo | null;
};

const STATUS_OPTIONS: ("ALL" | EquipmentStatus)[] = [
  "ALL",
  "AVAILABLE",
  "RESERVED",
  "CHECKED_OUT",
  "MAINTENANCE",
  "RETIRED",
];

type Holder = {
  userId: string;
  displayName: string | null;
  email: string | null;
  reservedAt: string; // ISO strings from API
  checkedOutAt: string | null;
  state: "RESERVED" | "CHECKED_OUT";
};

type AdminEquipRow = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: string;
  qrSlug?: string | null;
  createdAt: string;
  updatedAt: string;
  holder: Holder | null;
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

export default function AdminEquipment() {
  const [items, setItems] = useState<AdminEquipRow[]>([]);
  const [shortDesc, setShort] = useState("");
  const [longDesc, setLong] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Status filter (button chips)
  const [statusFilter, setStatusFilter] = useState<EquipmentStatus | "ALL">(
    "ALL"
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<AdminEquipRow[]>(
        "/api/v1/admin/equipment/with-holders"
      );
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

  useEffect(() => {
    const onUpd = () => void load();
    window.addEventListener("seedlings3:equipment-updated", onUpd);
    return () =>
      window.removeEventListener("seedlings3:equipment-updated", onUpd);
  }, [load]);

  const visibleItems = useMemo(() => {
    if (statusFilter === "ALL") return items;
    return items.filter((i) => i.status === statusFilter);
  }, [items, statusFilter]);

  async function create() {
    if (!shortDesc.trim()) {
      toaster.error({ title: "Short description is required" });
      return;
    }
    setCreating(true);
    try {
      await apiPost("/api/v1/admin/equipment", { shortDesc, longDesc });
      setShort("");
      setLong("");
      toaster.success({ title: "Created" });
      notifyEquipmentUpdated();
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

  async function retire(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/retire`);
      toaster.info({ title: "Retired" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Retire failed",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function unretire(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/unretire`);
      toaster.success({ title: "Unretired" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Unretire failed",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function release(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/release`);
      toaster.success({ title: "Released" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Release failed",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function del(id: string) {
    setBusyId(id);
    try {
      await apiDelete(`/api/v1/admin/equipment/${id}`);
      toaster.warning({ title: "Deleted" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Delete failed",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function startMaint(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/maintenance/start`);
      toaster.info({ title: "Maintenance started" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "Start maintenance failed",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function endMaint(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/api/v1/admin/equipment/${id}/maintenance/end`);
      toaster.success({ title: "Maintenance ended" });
      notifyEquipmentUpdated();
      await load();
    } catch (err) {
      toaster.error({
        title: "End maintenance failed",
        description: getErrorMessage(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Box>
      <Heading size="md" mb={3}>
        Equipment
      </Heading>

      {/* Filter chips */}
      <HStack mb={4} gap="2" wrap="wrap">
        {STATUS_OPTIONS.map((opt) => (
          <Button
            key={opt}
            size="sm"
            variant={statusFilter === opt ? "solid" : "outline"}
            onClick={() => setStatusFilter(opt)}
          >
            {opt === "ALL"
              ? "All"
              : opt === "CHECKED_OUT"
                ? "Checked out"
                : opt.charAt(0) + opt.slice(1).toLowerCase().replace("_", " ")}
          </Button>
        ))}
      </HStack>

      {/* Create form */}
      <Stack direction="row" gap="3" mb={4}>
        <Input
          placeholder="Short description"
          value={shortDesc}
          onChange={(ev) => setShort(ev.target.value)}
        />
        <Input
          placeholder="Long description"
          value={longDesc}
          onChange={(ev) => setLong(ev.target.value)}
        />
        <Button onClick={create} loading={creating}>
          Add
        </Button>
      </Stack>

      {/* List */}
      <Stack gap="3">
        {loading && <LoadingCenter />}

        {!loading &&
          visibleItems.map((item) => (
            <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
              <Heading size="sm">
                {item.shortDesc} <Badge ml={2}>{item.status}</Badge>
              </Heading>

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

              <Text fontSize="sm" color="gray.500">
                {item.longDesc}
              </Text>

              {/* Actions — order: Force Release, Start/End Maintenance, Retire/Unretire, Delete */}
              <Stack mt={2} direction="row" gap="2">
                {/* Force Release (RESERVED or CHECKED_OUT) */}
                <Button
                  size="sm"
                  onClick={() => release(item.id)}
                  disabled={
                    !!busyId ||
                    !(
                      item.status === "CHECKED_OUT" ||
                      item.status === "RESERVED"
                    )
                  }
                  loading={busyId === item.id}
                >
                  Force Release
                </Button>

                {/* Maintenance toggle */}
                {item.status === "MAINTENANCE" ? (
                  <Button
                    size="sm"
                    onClick={() => endMaint(item.id)}
                    disabled={!!busyId}
                    loading={busyId === item.id}
                    variant="subtle"
                    colorPalette="green"
                  >
                    End Maintenance
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => startMaint(item.id)}
                    disabled={
                      !!busyId ||
                      item.status === "CHECKED_OUT" ||
                      item.status === "RESERVED" ||
                      item.status === "RETIRED"
                    }
                    loading={busyId === item.id}
                    variant="subtle"
                  >
                    Start Maintenance
                  </Button>
                )}

                {/* Retire ↔ Unretire */}
                {item.status === "RETIRED" ? (
                  <Button
                    size="sm"
                    onClick={() => unretire(item.id)}
                    disabled={!!busyId}
                    loading={busyId === item.id}
                    variant="outline"
                  >
                    Unretire
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => retire(item.id)}
                    disabled={
                      !!busyId ||
                      item.status === "CHECKED_OUT" ||
                      item.status === "RESERVED"
                    }
                    loading={busyId === item.id}
                    variant="outline"
                  >
                    Retire
                  </Button>
                )}

                {/* Delete (only when RETIRED) */}
                <Button
                  size="sm"
                  onClick={() => del(item.id)}
                  disabled={!!busyId || item.status !== "RETIRED"}
                  loading={busyId === item.id}
                  colorPalette="red"
                >
                  Delete
                </Button>
              </Stack>
            </Box>
          ))}

        {!loading && visibleItems.length === 0 && (
          <Text>No equipment matching this filter.</Text>
        )}
      </Stack>
    </Box>
  );
}
