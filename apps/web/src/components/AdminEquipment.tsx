import { useEffect, useState, useCallback } from "react";
import {
  Box,
  Button,
  Heading,
  Stack,
  Text,
  Input,
  Badge,
  Spinner,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete } from "../lib/api";
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

export default function AdminEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [shortDesc, setShort] = useState("");
  const [longDesc, setLong] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    const onUpd = () => void load();
    window.addEventListener("seedlings3:equipment-updated", onUpd);
    return () =>
      window.removeEventListener("seedlings3:equipment-updated", onUpd);
  }, [load]);

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
      <Heading size="md" mb={4}>
        Equipment
      </Heading>

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
          items.map((item) => (
            <Box key={item.id} p={4} borderWidth="1px" borderRadius="lg">
              <Heading size="sm">
                {item.shortDesc} <Badge ml={2}>{item.status}</Badge>
              </Heading>
              <Text fontSize="sm" color="gray.500">
                {item.longDesc}
              </Text>

              {/* Actions — order: Force Release, Start/End Maintenance, Retire/Unretire, Delete */}
              <Stack mt={2} direction="row" gap="2">
                {/* Force Release (only when CHECKED_OUT) */}
                <Button
                  size="sm"
                  onClick={() => release(item.id)}
                  disabled={!!busyId || item.status !== "CHECKED_OUT"}
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
                    disabled={!!busyId || item.status === "CHECKED_OUT"}
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

        {!loading && items.length === 0 && <Text>No equipment yet.</Text>}
      </Stack>
    </Box>
  );
}
