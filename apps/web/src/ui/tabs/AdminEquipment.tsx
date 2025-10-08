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
  HStack,
  Separator,
  Collapsible,
  Icon,
} from "@chakra-ui/react";
import { ChevronDown, Plus } from "lucide-react";
import { apiGet, apiPost } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import {
  Me,
  EquipmentStatus,
  Equipment,
  InlineMessageType,
  EQUIPMENT_TYPES,
  EQUIPMENT_ENERGY,
} from "../../lib/types";
import EquipmentTile from "../components/EquipmentTile";
import LoadingCenter from "../helpers/LoadingCenter";
import InlineMessage from "../helpers/InlineMessage";

export default function AdminEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<
    "all" | "available" | "reserved" | "checked_out" | "maintenance" | "retired"
  >("all");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [inlineMsg, setInlineMsg] = useState<{
    msg: string;
    type: InlineMessageType;
  } | null>(null);

  // create form state
  const [creating, setCreating] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newQr, setNewQr] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newType, setNewType] = useState("");
  const [newEnergy, setNewEnergy] = useState("");
  const [open, setOpen] = useState(false);

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
    const energy = newEnergy.trim();

    setCreating(true);
    try {
      await apiPost("/api/admin/equipment", {
        shortDesc,
        longDesc: longDesc || undefined,
        qrSlug: qrSlug || undefined,
        brand,
        model,
        type,
        energy,
      });
      setNewShort("");
      setNewLong("");
      setNewQr("");
      setNewBrand("");
      setNewModel("");
      setNewType("");
      setNewEnergy("");
      await load();
      setInlineMsg({
        msg: "Equipment created",
        type: InlineMessageType.SUCCESS,
      });
    } catch (err) {
      setInlineMsg({
        msg: "Equipment create failed",
        type: InlineMessageType.SUCCESS,
      });
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

      {inlineMsg && <InlineMessage type={inlineMsg.type} msg={inlineMsg.msg} />}

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
        <Collapsible.Root
          open={open}
          onOpenChange={({ open }) => setOpen(open)}
        >
          <HStack justify="space-between" mb="2">
            <Collapsible.Trigger asChild>
              <Button variant="outline" size="sm">
                <HStack gap="2">
                  <Icon as={Plus} boxSize={4} />
                  <span>Create equipment</span>
                  <Icon
                    as={ChevronDown}
                    boxSize={4}
                    style={{ transition: "transform 0.2s ease" }}
                    transform={open ? "rotate(180deg)" : "rotate(0deg)"}
                  />
                </HStack>
              </Button>
            </Collapsible.Trigger>
          </HStack>

          <Collapsible.Content>
            <Box
              p="4"
              borderWidth="1px"
              borderRadius="lg"
              bg="white"
              _dark={{ bg: "gray.800" }}
            >
              <Stack gap="3">
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

                <NativeSelectRoot size="sm">
                  <NativeSelectField
                    value={newEnergy}
                    onChange={(e) => setNewEnergy(e.target.value)}
                    placeholder="Select Energy *"
                  >
                    <option value="" />
                    {EQUIPMENT_ENERGY.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </NativeSelectField>
                </NativeSelectRoot>

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

                <Separator my="2" />

                <HStack justify="flex-end" gap="2">
                  <Collapsible.Trigger asChild>
                    <Button variant="ghost" size="sm">
                      Cancel
                    </Button>
                  </Collapsible.Trigger>
                  <Button
                    size="sm"
                    onClick={createEquipment}
                    disabled={
                      creating ||
                      !newShort.trim() ||
                      !newBrand.trim() ||
                      !newModel.trim() ||
                      !newType.trim() ||
                      !newEnergy.trim()
                    }
                  >
                    <HStack gap="2">
                      <span>Create</span>
                    </HStack>
                  </Button>
                </HStack>
              </Stack>
            </Box>
          </Collapsible.Content>
        </Collapsible.Root>
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
            setMessage={(msg: string, type: InlineMessageType) => {
              setInlineMsg({ msg: msg, type: type });
            }}
          />
        );
      })}
    </Box>
  );
}
