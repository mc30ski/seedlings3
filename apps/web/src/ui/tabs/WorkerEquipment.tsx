import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  Text,
  Stack,
  Button,
  NativeSelectField,
  NativeSelectRoot,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import {
  Me,
  EquipmentStatus,
  Equipment,
  EQUIPMENT_TYPES,
} from "@/src/lib/types";
import EquipmentTile from "@/src/ui/components/EquipmentTile";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

export default function WorkerEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<
    "claimed" | "available" | "unavailable" | "all"
  >("claimed");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, meResp] = await Promise.all([
        apiGet<Equipment[]>("/api/equipment/all"),
        apiGet<Me>("/api/me"),
      ]);
      const anyClaimed =
        data.filter((i) => i.holder?.userId === meResp?.id).length > 0;
      setStatus(anyClaimed ? "claimed" : "available");
      setMe(meResp);
      setItems(data);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load equipment", err),
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
        case "claimed":
          want = ["RESERVED", "CHECKED_OUT"];
          break;
        case "available":
          want = ["AVAILABLE"];
          break;
        case "unavailable":
          want = ["RESERVED", "CHECKED_OUT", "MAINTENANCE"];
          break;
      }
      if (want) rows = rows.filter((r) => want!.includes(r.status));

      if (status === "claimed") {
        rows = rows.filter((r) => r.holder?.userId === me?.id);
      }
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
        const s7 = (r.energy || "").toLowerCase();
        const s8 = (r.features || "").toLowerCase();
        const s9 = (r.condition || "").toLowerCase();
        const s10 = (r.issues || "").toLowerCase();
        const s11 = (r.age || "").toLowerCase();
        const s12 = (r.qrSlug || "").toLowerCase();
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
          s7.includes(qlc) ||
          s8.includes(qlc) ||
          s9.includes(qlc) ||
          s10.includes(qlc) ||
          s11.includes(qlc) ||
          s12.includes(qlc) ||
          who.includes(qlc)
        );
      });
    }

    return rows;
  }, [items, status, search, filterType]);

  if (loading) return <LoadingCenter />;

  return (
    <Box>
      <Stack
        direction={{ base: "column", md: "row" }}
        gap="2"
        align={{ base: "stretch", md: "center" }}
        mb={3}
      >
        <Box display="flex" flexWrap="wrap" gap="6px">
          {(
            [
              ["claimed", "Claimed"],
              ["available", "Available"],
              ["unavailable", "Unavailable"],
              ["all", "All"],
            ] as const
          ).map(([val, label]) => (
            <Button
              key={val}
              size="sm"
              variant={status === val ? "solid" : "outline"}
              onClick={() => {
                setStatus(val);
              }}
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
          <SearchWithClear
            value={search}
            onChange={setSearch}
            inputId="equipment-search"
            placeholder="Search equipment…"
          />
        </Box>
      </Stack>

      {/* Separator */}
      <Box h="1px" bg="gray.200" mb={3} />

      <Heading size="md" mb={3}>
        {status === "claimed"
          ? "Equipment I've Claimed"
          : status === "available"
            ? "Equipment Available to Reserve"
            : status === "unavailable"
              ? "Equipment Already Claimed or Unavailable"
              : "All Equipment"}
      </Heading>

      {filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}
      {filtered.map((item) => {
        const isMine = !!me && !!item.holder && item.holder.userId === me.id;
        return (
          <EquipmentTile
            item={item}
            isMine={isMine}
            isSuper={false}
            role={"WORKER"}
            filter={status}
            refresh={load}
          />
        );
      })}
    </Box>
  );
}
