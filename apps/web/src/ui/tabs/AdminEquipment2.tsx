import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Heading, Text, Stack, Button, Input } from "@chakra-ui/react";
import { apiGet, apiPost } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { Me, EquipmentStatus, Equipment } from "../../lib/types";
import EquipmentTile from "../components/EquipmentTile";
import LoadingCenter from "../helpers/LoadingCenter";
import InlineError from "../helpers/InlineMessage";

export default function AdminEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<
    "all" | "available" | "reserved" | "checked_out" | "maintenance" | "retired"
  >("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // create form state
  const [creating, setCreating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newQr, setNewQr] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [newModel, setNewModel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Equipment[]>("/api/admin/equipment");
      setItems(data);
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

    const qlc = search.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const s1 = (r.status || "").toLowerCase();
        const s2 = (r.brand || "").toLowerCase();
        const s3 = (r.model || "").toLowerCase();
        const s4 = (r.shortDesc || "").toLowerCase();
        const s5 = (r.longDesc || "").toLowerCase();
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
          who.includes(qlc)
        );
      });
    }

    return rows;
  }, [items, status, search]);

  async function createEquipment() {
    const shortDesc = newShort.trim();
    const longDesc = newLong.trim();
    const qrSlug = newQr.trim();
    const brand = newBrand.trim();
    const model = newModel.trim();

    setCreating(true);
    try {
      await apiPost("/api/admin/equipment", {
        shortDesc,
        longDesc: longDesc || undefined,
        qrSlug: qrSlug || undefined,
        brand,
        model,
      });
      setNewShort("");
      setNewLong("");
      setNewQr("");
      setNewBrand("");
      setNewModel("");
      await load();
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
              disabled={
                creating ||
                !newShort.trim() ||
                !newBrand.trim() ||
                !newModel.trim()
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

        <Input
          placeholder="Search description / holder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          w={{ base: "100%", md: "320px" }}
        />
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
      {success && <InlineError type="SUCCESS" msg="Equipment created" />}

      {!error && filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}
      {filtered.map((item) => {
        return (
          <EquipmentTile
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
