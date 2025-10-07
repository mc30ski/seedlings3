// apps/web/src/components/WorkerAll.tsx
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
import { apiGet } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import {
  Me,
  EquipmentStatus,
  Equipment,
  InlineMessageType,
  EQUIPMENT_TYPES,
} from "../../lib/types";
import EquipmentTileList from "../components/EquipmentTileList";
import LoadingCenter from "../helpers/LoadingCenter";
import InlineMessage from "../helpers/InlineMessage";

export default function WorkerEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<
    "claimed" | "available" | "unavailable" | "all"
  >("claimed");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [inlineMsg, setInlineMsg] = useState<{
    msg: string;
    type: InlineMessageType;
  } | null>(null);

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
      setInlineMsg({
        msg: getErrorMessage(err),
        type: InlineMessageType.ERROR,
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
                setStatus(val), setInlineMsg(null);
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
        {status === "claimed"
          ? "Equipment I've Claimed"
          : status === "available"
            ? "Equipment Available to Reserve"
            : status === "unavailable"
              ? "Equipment Already Claimed or Unavailable"
              : "All Equipment"}
      </Heading>

      {inlineMsg && <InlineMessage type={inlineMsg.type} msg={inlineMsg.msg} />}

      {filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}
      {filtered.map((item) => {
        const isMine = !!me && !!item.holder && item.holder.userId === me.id;
        return (
          <EquipmentTileList
            item={item}
            isMine={isMine}
            role={"WORKER"}
            filter={status}
            refresh={load}
            setMessage={(msg: string, type: InlineMessageType) => {
              setInlineMsg({ msg: msg, type: type });
            }}
          />
        );
      })}
    </Box>
  );
}
