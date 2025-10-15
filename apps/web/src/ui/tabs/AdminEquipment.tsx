import { useCallback, useEffect, useMemo, useState, useRef } from "react";
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
import EquipmentEditor from "@/src/ui/components/EquipmentEditor";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

export default function AdminEquipment() {
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<Equipment[]>([]);
  const [status, setStatus] = useState<
    "all" | "available" | "reserved" | "checked_out" | "maintenance" | "retired"
  >("all");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, meResp] = await Promise.all([
        apiGet<Equipment[]>("/api/equipment/all"),
        apiGet<Me>("/api/me"),
      ]);
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

  useEffect(() => {
    const onRun = (ev: Event) => {
      const { q } = (ev as CustomEvent<{ q?: string }>).detail || {};
      if (typeof q === "string") {
        setSearch(q);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
        // optionally: runSearch(q)
      }
    };
    window.addEventListener("equipmentSearch:run", onRun as EventListener);
    return () =>
      window.removeEventListener("equipmentSearch:run", onRun as EventListener);
  }, []);

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
            ref={inputRef}
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

      {status === "all" && (
        <EquipmentEditor
          mode="create"
          onSuccess={() => void load()}
          onCancel={() => {}}
        />
      )}

      {filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}
      {filtered.map((item) => {
        const isMine = !!me && !!item.holder && item.holder.userId === me.id;
        return (
          <EquipmentTile
            item={item}
            isMine={isMine}
            isSuper={me?.roles?.includes("SUPER") ? true : false}
            role={"ADMIN"}
            filter={status}
            refresh={load}
          />
        );
      })}
    </Box>
  );
}
