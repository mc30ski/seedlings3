import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  Text,
  Stack,
  Button,
  Input,
  NativeSelectField,
  NativeSelectRoot,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { EquipmentStatus, Equipment, EQUIPMENT_TYPES } from "../../lib/types";
import EquipmentTileList from "../components/EquipmentTileList";
import LoadingCenter from "../helpers/LoadingCenter";
import InlineError from "../helpers/InlineMessage";

export default function AdminEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<
    "all" | "available" | "reserved" | "checked_out" | "maintenance" | "retired"
  >("all");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // create form state
  const [creating, setCreating] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newQr, setNewQr] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newType, setNewType] = useState("");

  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Equipment[]>("/api/admin/equipment");
      setItems(data);
      setSuccess("");
      setError(false);
      setErrorMsg("");
    } catch (err) {
      setError(true);
      setErrorMsg(getErrorMessage(err));
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

    if (filterType) {
      rows = rows.filter((r) => r.type === filterType);
    }

    const qlc = search.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const s1 = (r.status || "").toLowerCase();
        const s2 = (r.brand || "").toLowerCase();
        const s3 = (r.model || "").toLowerCase();
        const s4 = (r.shortDesc || "").toLowerCase();
        const s5 = (r.longDesc || "").toLowerCase();
        const s6 = (r.type || "").toLowerCase();
        const who =
          r.holder?.displayName?.toLowerCase() ||
          r.holder?.email?.toLowerCase() ||
          "";
        return (
          s1.includes(qlc) ||
          s2.includes(qlc) ||
          s3.includes(qlc) ||
          s4.includes(qlc) ||
          s5.includes(qlc) ||
          s6.includes(qlc) ||
          who.includes(qlc)
        );
      });
    }

    return rows;
  }, [items, status, search, filterType]);

  async function createEquipment() {
    const shortDesc = newShort.trim();
    const longDesc = newLong.trim();
    const qrSlug = newQr.trim();
    const brand = newBrand.trim();
    const model = newModel.trim();
    const type = newType.trim();

    setCreating(true);
    try {
      await apiPost("/api/admin/equipment", {
        shortDesc,
        longDesc: longDesc || undefined,
        qrSlug: qrSlug || undefined,
        brand,
        model,
        type,
      });
      setNewShort("");
      setNewLong("");
      setNewQr("");
      setNewBrand("");
      setNewModel("");
      setNewType("");
      await load();
      setSuccess("Equipment created");
    } catch (err) {
      setErrorMsg("Equipment create failed");
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <LoadingCenter />;

  return (
    <Box>
      <Stack
        direction={{ base: "column", md: "row" }}
        gap="2"
        align={{ base: "stretch", md: "center" }}
        mb={3}
      >
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
            <NativeSelectRoot size="sm">
              <NativeSelectField
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                placeholder="Type *"
              >
                <option value="" />
                {EQUIPMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </NativeSelectField>
            </NativeSelectRoot>
            <Input
              placeholder="Brand *"
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
            />
            <Input
              placeholder="Model *"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
            />
            <Input
              placeholder="Description *"
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
              disabled={
                creating ||
                !newShort.trim() ||
                !newBrand.trim() ||
                !newModel.trim() ||
                !newType.trim()
              }
              size={{ base: "sm", md: "sm" }}
            >
              Create
            </Button>
          </Stack>
        </Box>
      </Stack>

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
      </Stack>

      <Stack
        direction={{ base: "column", md: "row" }}
        gap="2"
        align={{ base: "stretch", md: "center" }}
        mb={3}
      >
        <Box display="flex" flexWrap="wrap" gap="6px">
          <NativeSelectRoot size="sm">
            <NativeSelectField
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              placeholder="Select Type"
            >
              <option value="" />
              {EQUIPMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelectField>
          </NativeSelectRoot>
        </Box>
        <Box display="flex" flexWrap="wrap" gap="6px">
          <Input
            placeholder="Search description / holder…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            w={{ base: "100%", md: "320px" }}
          />
        </Box>
      </Stack>

      {/* Separator */}
      <Box h="1px" bg="gray.200" mb={3} />

      <Heading size="md" mb={3}>
        {status === "available"
          ? "Equipment Available to Reserve"
          : status === "reserved"
            ? "Equipment Already Reserved"
            : status === "checked_out"
              ? "Equipment Already Checked Out"
              : status === "maintenance"
                ? "Equipment in Maintenance"
                : status === "retired"
                  ? "Equipment in Retired"
                  : "All Equipment"}
      </Heading>

      {error && <InlineError type="ERROR" msg={errorMsg} />}
      {success && <InlineError type="SUCCESS" msg={success} />}

      {!error && filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}
      {filtered.map((item) => {
        return (
          <EquipmentTileList
            item={item}
            isMine={false}
            role={"ADMIN"}
            filter={status}
            refresh={load}
          />
        );
      })}
    </Box>
  );
}
