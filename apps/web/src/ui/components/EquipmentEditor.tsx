"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  HStack,
  Stack,
  Input,
  Collapsible,
  Text,
  Separator,
  SelectRoot,
  SelectTrigger,
  SelectValueText,
  SelectContent,
  SelectItem,
  createListCollection,
  Icon,
} from "@chakra-ui/react";
import { ChevronDown, Plus } from "lucide-react";
import { apiPost, apiPatch } from "@/src/lib/api";
import { EQUIPMENT_TYPES, EQUIPMENT_ENERGY, Equipment } from "@/src/lib/types";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

export type EquipmentUpsert = Omit<Equipment, "id"> & { id?: string };

type Mode = "create" | "update";

type Props = {
  mode: Mode;
  /** For update mode, pass the record to edit. For create, this is ignored. */
  item?: Equipment | null;
  /** Initial defaults for update mode (optional) */
  defaults?: Partial<EquipmentUpsert>;
  /** Called after successful submit with the saved record (server response) */
  onSuccess?: (saved: Equipment) => void;
  /** Called when user cancels (useful in tile inline edit) */
  onCancel?: () => void;
  /** Customize submit button label (defaults handled per mode) */
  submitLabel?: string;
  /** When embedded in a tile, set compact to reduce paddings */
  compact?: boolean;
  /** Optional: show the status picker */
  showStatus?: boolean;
};

/**
 * Reusable editor for Equipment:
 * - mode=create: POST /api/admin/equipment
 * - mode=update: PATCH /api/admin/equipment/:id
 * Adjust endpoints if your API differs.
 */
export default function EquipmentEditor({
  mode,
  item,
  defaults,
  onSuccess,
  onCancel,
  submitLabel,
  compact = false,
}: Props) {
  const initial = useMemo<EquipmentUpsert>(() => {
    if (mode === "update" && item) {
      // convert nullable fields to empty strings for inputs
      return {
        id: item.id,
        type: item.type ?? "",
        qrSlug: item.type ?? "",
        shortDesc: item.shortDesc ?? "",
        brand: item.brand ?? "",
        model: item.model ?? "",
        energy: item.energy ?? "",
        longDesc: item.longDesc ?? "",
        features: item.features ?? "",
        condition: item.condition ?? "",
        issues: item.issues ?? "",
        age: item.age ?? "",
      };
    }
    return {
      id: defaults?.id,
      type: "",
      qrSlug: "",
      shortDesc: "",
      brand: "",
      model: "",
      energy: "",
      longDesc: "",
      features: "",
      condition: "",
      issues: "",
      age: "",
      ...defaults,
    };
  }, [mode, item, defaults]);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EquipmentUpsert>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // re-seed when item/defaults change
    setForm(initial);
  }, [initial]);

  const set = <K extends keyof EquipmentUpsert>(k: K, v: EquipmentUpsert[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const canSubmit =
    !saving &&
    (form.type ?? "").trim().length > 0 &&
    (form.qrSlug ?? "").trim().length > 0 &&
    (form.shortDesc ?? "").trim().length > 0 &&
    (form.brand ?? "").trim().length > 0 &&
    (form.model ?? "").trim().length > 0 &&
    (form.energy ?? "").trim().length > 0 &&
    (mode === "create" || !!(form.id ?? item?.id));

  const doSubmit = async () => {
    if (!canSubmit) return;

    setSaving(true);
    try {
      const payload: any = {
        type: (form.type ?? "").trim(),
        qrSlug: (form.qrSlug ?? "").trim(),
        shortDesc: (form.shortDesc ?? "").trim(),
        brand: (form.brand ?? "").trim(),
        model: (form.model ?? "").trim(),
        energy: (form.energy ?? "").trim(),
        longDesc: (form.longDesc ?? "").trim(),
        features: (form.features ?? "").trim(),
        condition: (form.condition ?? "").trim(),
        issues: (form.issues ?? "").trim(),
        age: (form.age ?? "").trim(),
      };

      let res: Equipment;
      if (mode === "create") {
        res = await apiPost<Equipment>("/api/admin/equipment", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: "Equipment created successfully.",
        });
      } else {
        const id = form.id ?? item?.id;
        if (!id) throw new Error("Missing equipment id");

        res = await apiPatch<Equipment>(`/api/admin/equipment/${id}`, payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: "Equipment updated successfully.",
        });
      }

      // notify outer world
      try {
        window.dispatchEvent(new Event("seedlings3:equipment-changed"));
      } catch {}

      onSuccess?.(res);

      // reset on create
      if (mode === "create") {
        setForm({
          type: "",
          qrSlug: "",
          shortDesc: "",
          brand: "",
          model: "",
          energy: "",
          longDesc: "",
          features: "",
          condition: "",
          issues: "",
          age: "",
          ...defaults, // keep any provided defaults
        });
      }

      setOpen(false);
    } catch (err: any) {
      publishInlineMessage({
        type: "ERROR",
        text: String("Save failed. " + (err?.message ?? err ?? "")),
      });
    } finally {
      setSaving(false);
    }
  };

  const spacing = compact ? 2 : 3;
  const pad = compact ? 2 : 3;

  type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

  const EQUIPMENT_TYPE_OPTIONS = EQUIPMENT_TYPES.map((t) => ({
    label: t,
    value: t,
  }));

  const equipmentTypeCollection = createListCollection({
    items: EQUIPMENT_TYPE_OPTIONS,
    itemToString: (it) => it.label,
    itemToValue: (it) => it.value,
  });

  type EquipmentEnergyType = (typeof EQUIPMENT_ENERGY)[number];

  const EQUIPMENT_ENERGY_TYPE_OPTIONS = EQUIPMENT_ENERGY.map((t) => ({
    label: t,
    value: t,
  }));

  const equipmentEnergyTypeCollection = createListCollection({
    items: EQUIPMENT_ENERGY_TYPE_OPTIONS,
    itemToString: (it) => it.label,
    itemToValue: (it) => it.value,
  });

  return (
    <>
      <Collapsible.Root open={open} onOpenChange={({ open }) => setOpen(open)}>
        <HStack justify="space-between" mb="2">
          <Collapsible.Trigger asChild>
            <Button variant="outline" size="sm">
              <HStack gap="2">
                {mode === "create" && <Icon as={Plus} boxSize={4} />}
                <span>{mode === "create" ? "Create" : "Update"}</span>
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
            <Box
              borderWidth={compact ? "0px" : "1px"}
              borderRadius="md"
              p={pad}
            >
              {!compact && (
                <>
                  <Text fontSize="sm" color="gray.600" mb={2}>
                    {mode === "create"
                      ? "Create new equipment"
                      : "Update existing equipment"}
                  </Text>
                  <Separator mb={spacing} />
                </>
              )}

              <Stack gap={spacing}>
                <SelectRoot
                  collection={equipmentTypeCollection}
                  multiple={false}
                  value={form.type ? [form.type] : []}
                  onValueChange={({ value }) =>
                    set(
                      "type",
                      ((value as string[])[0] ?? "") as EquipmentType | ""
                    )
                  }
                  aria-label="Type"
                >
                  <SelectTrigger>
                    <SelectValueText placeholder="Type *" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem item="">—</SelectItem>
                    {EQUIPMENT_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} item={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
                <Input
                  value={form.qrSlug ?? ""}
                  onChange={(e) => set("qrSlug", e.target.value)}
                  placeholder="ID / QRSlug *"
                  aria-label="ID / QRSlug"
                  required
                />
                <Input
                  value={form.shortDesc ?? ""}
                  onChange={(e) => set("shortDesc", e.target.value)}
                  placeholder="Summary *"
                  aria-label="Summary"
                  required
                />
                <Input
                  value={form.brand ?? ""}
                  onChange={(e) => set("brand", e.target.value)}
                  placeholder="Brand *"
                  aria-label="Brand"
                  required
                />
                <Input
                  value={form.model ?? ""}
                  onChange={(e) => set("model", e.target.value)}
                  placeholder="Model *"
                  aria-label="Model"
                  required
                />
                <SelectRoot
                  collection={equipmentEnergyTypeCollection}
                  multiple={false}
                  value={form.energy ? [form.energy] : []}
                  onValueChange={({ value }) =>
                    set(
                      "energy",
                      ((value as string[])[0] ?? "") as EquipmentEnergyType | ""
                    )
                  }
                  aria-label="Energy"
                >
                  <SelectTrigger>
                    <SelectValueText placeholder="Energy *" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem item="">—</SelectItem>
                    {EQUIPMENT_ENERGY_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} item={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>

                <HStack gap={spacing} flexWrap="wrap">
                  <Input
                    value={form.longDesc ?? ""}
                    onChange={(e) => set("longDesc", e.target.value)}
                    placeholder="Details"
                    aria-label="Details"
                    flex="1 1 140px"
                    minW="140px"
                  />
                </HStack>
                <HStack gap={spacing} flexWrap="wrap">
                  <Input
                    value={form.features ?? ""}
                    onChange={(e) => set("features", e.target.value)}
                    placeholder="Features"
                    aria-label="Features"
                    flex="1 1 140px"
                    minW="140px"
                  />
                  <Input
                    value={form.condition ?? ""}
                    onChange={(e) => set("condition", e.target.value)}
                    placeholder="Condition"
                    aria-label="Condition"
                    flex="1 1 140px"
                    minW="140px"
                  />
                  <Input
                    value={form.issues ?? ""}
                    onChange={(e) => set("issues", e.target.value)}
                    placeholder="Issues"
                    aria-label="Issues"
                    flex="1 1 140px"
                    minW="140px"
                  />
                  <Input
                    value={form.age ?? ""}
                    onChange={(e) => set("age", e.target.value)}
                    placeholder="Age"
                    aria-label="Age"
                    flex="1 1 140px"
                    minW="140px"
                  />
                </HStack>

                <HStack gap={2} justify="flex-end" pt={1}>
                  {onCancel && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        onCancel();
                      }}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={doSubmit}
                    disabled={!canSubmit}
                    loading={saving}
                  >
                    {submitLabel ?? (mode === "create" ? "Create" : "Update")}
                  </Button>
                </HStack>
              </Stack>
            </Box>
          </Box>
        </Collapsible.Content>
      </Collapsible.Root>
    </>
  );
}
