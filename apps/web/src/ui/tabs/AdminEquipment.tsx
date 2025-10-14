import { useCallback, useEffect, useMemo, useState, useRef } from "react";
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
  EQUIPMENT_TYPES,
  EQUIPMENT_ENERGY,
} from "../../lib/types";
import EquipmentTile from "../components/EquipmentTile";
import SearchWithClear from "../components/SearchWithClear";
import LoadingCenter from "../helpers/LoadingCenter";
import InlineMessage, { InlineMessageType } from "../helpers/InlineMessage";

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

  const inputRef = useRef<HTMLInputElement>(null);

  // create form state
  const [creating, setCreating] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newQr, setNewQr] = useState("");
  const [newBrand, setNewBrand] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newType, setNewType] = useState("");
  const [newEnergy, setNewEnergy] = useState("");
  const [newFeatures, setNewFeatures] = useState("");
  const [newCondition, setNewCondition] = useState("");
  const [newIssues, setNewIssues] = useState("");
  const [newAge, setNewAge] = useState("");

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
        msg: "Failed to load equipment: " + getErrorMessage(err),
        type: InlineMessageType.ERROR,
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

  function clearForm() {
    setNewShort("");
    setNewLong("");
    setNewQr("");
    setNewBrand("");
    setNewModel("");
    setNewType("");
    setNewEnergy("");
    setNewFeatures("");
    setNewCondition("");
    setNewIssues("");
    setNewAge("");
  }

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

  async function createEquipment() {
    const shortDesc = newShort.trim();
    const longDesc = newLong.trim();
    const qrSlug = newQr.trim();
    const brand = newBrand.trim();
    const model = newModel.trim();
    const type = newType.trim();
    const energy = newEnergy.trim();
    const features = newFeatures.trim();
    const condition = newCondition.trim();
    const issues = newIssues.trim();
    const age = newAge.trim();

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
        features,
        condition,
        issues,
        age,
      });
      clearForm();
      await load();
      setInlineMsg({
        msg: "Equipment created",
        type: InlineMessageType.SUCCESS,
      });
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error";
      setInlineMsg({
        msg: "Equipment create failed: " + message,
        type: InlineMessageType.ERROR,
      });
    } finally {
      setCreating(false);
    }
  }

  function onCancel() {
    clearForm();
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
                {/* --- your existing form fields --- */}
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
                  placeholder="ID / QR slug *"
                  value={newQr}
                  onChange={(e) => setNewQr(e.target.value)}
                />
                <Input
                  placeholder="Summary *"
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
                  placeholder="Features (optional)"
                  value={newFeatures}
                  onChange={(e) => setNewFeatures(e.target.value)}
                />
                <Input
                  placeholder="Condition (optional)"
                  value={newCondition}
                  onChange={(e) => setNewCondition(e.target.value)}
                />
                <Input
                  placeholder="Issues (optional)"
                  value={newIssues}
                  onChange={(e) => setNewIssues(e.target.value)}
                />
                <Input
                  placeholder="Age (optional)"
                  value={newAge}
                  onChange={(e) => setNewAge(e.target.value)}
                />

                <Separator my="2" />

                <HStack justify="flex-end" gap="2">
                  {/* IMPORTANT: this is NOT a Trigger */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setOpen(false); // close the section
                      onCancel(); // run your cancel side-effects
                    }}
                  >
                    Cancel
                  </Button>

                  <Button
                    size="sm"
                    onClick={createEquipment}
                    disabled={
                      creating ||
                      !newShort.trim() ||
                      !newBrand.trim() ||
                      !newModel.trim() ||
                      !newType.trim() ||
                      !newEnergy.trim() ||
                      !newQr.trim()
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
