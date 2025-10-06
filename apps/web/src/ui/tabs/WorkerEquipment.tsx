// apps/web/src/components/WorkerAll.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  Text,
  HStack,
  Stack,
  Button,
  Input,
} from "@chakra-ui/react";
import { apiGet } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { Me, EquipmentStatus, Equipment } from "../../lib/types";
import EquipmentTile from "../components/EquipmentTile";
import LoadingCenter from "../helpers/LoadingCenter";

export default function WorkerEquipment2() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<
    "claimed" | "available" | "unavailable" | "all"
  >("claimed");
  const [search, setSearch] = useState("");
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

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
        {status === "claimed"
          ? "Equipment I've Claimed"
          : status === "available"
            ? "Equipment Available to Reserve"
            : status === "unavailable"
              ? "Equipment Already Claimed or Unavailable"
              : "All Equipment"}
      </Heading>

      {error && (
        <HStack
          w="full"
          mt={2}
          align="start"
          p={2.5}
          borderRadius="md"
          borderWidth="1px"
          borderColor="red.300"
          bg="red.50"
        >
          <Box flex="1">
            <Text fontSize="sm" color="red.900">
              Failed to load equipment: {errorMsg}
            </Text>
          </Box>
        </HStack>
      )}

      {!error && filtered.length === 0 && (
        <Text>No equipment matches the current filters.</Text>
      )}
      {filtered.map((item) => {
        const isMine = !!me && !!item.holder && item.holder.userId === me.id;
        return (
          <EquipmentTile
            item={item}
            isMine={isMine}
            filter={status}
            refresh={load}
          />
        );
      })}
    </Box>
  );
}
