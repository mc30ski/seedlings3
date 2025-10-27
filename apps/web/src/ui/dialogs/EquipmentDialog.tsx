"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiPost, apiPatch } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

export const EQUIPMENT_TYPES = [
  "MOWER",
  "TRIMMER",
  "BLOWER",
  "HEDGER",
  "EDGER",
  "CUTTER",
  "SPREADER",
  "WASHER",
  "MISC",
] as const;

export const EQUIPMENT_ENERGY = [
  "87 Octane",
  "93 Octane",
  "50:1 Mixed",
  "40:1 Mixed",
  "Electric Plugin",
  "Electric Battery",
  "Manual",
] as const;

export type EquipmentEnergy = (typeof EQUIPMENT_ENERGY)[number];

export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export type EquipmentStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "CHECKED_OUT"
  | "MAINTENANCE"
  | "RETIRED";

export type EquipmentHolder = {
  userId: string;
  displayName: string | null;
  email: string | null;
  reservedAt: string; // ISO
  checkedOutAt: string | null;
  state: "RESERVED" | "CHECKED_OUT";
};

export type Equipment = {
  id: string;
  type: EquipmentType;
  qrSlug: string;
  shortDesc: string;
  brand: string;
  model: string;
  energy: EquipmentEnergy;

  longDesc?: string | undefined;
  features?: string | undefined;
  condition?: string | undefined;
  issues?: string | undefined;
  age?: string | undefined;

  status?: EquipmentStatus | undefined;

  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  retiredAt?: string | undefined;

  holder?: EquipmentHolder | undefined;
};

type Mode = "create" | "update";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  initial?: Equipment | null;
  onSaved?: (saved: any) => void;
  actionLabel?: string;
};

export default function EquipmentDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSaved,
  actionLabel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const [busy, setBusy] = useState(false);

  // --- Form state
  const [type, setType] = useState<EquipmentType>(EQUIPMENT_TYPES[0]);
  const [qrSlug, setQrSlug] = useState("");
  const [shortDesc, setShortDesc] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [energy, setEnergy] = useState<EquipmentEnergy>(EQUIPMENT_ENERGY[0]);
  const [longDesc, setLongDesc] = useState<string | undefined>("");
  const [features, setFeatures] = useState<string | undefined>("");
  const [condition, setCondition] = useState<string | undefined>("");
  const [issues, setIssues] = useState<string | undefined>("");
  const [age, setAge] = useState<string | undefined>("");

  // Seed form when opened or when switching clients
  useEffect(() => {
    if (!open) return;
    if (mode === "update" && initial) {
      setType(initial.type);
      setQrSlug(initial.qrSlug);
      setShortDesc(initial.shortDesc);
      setBrand(initial.brand);
      setModel(initial.model);
      setEnergy(initial.energy);
      setLongDesc(initial.longDesc);
      setFeatures(initial.features);
      setCondition(initial.condition);
      setIssues(initial.issues);
      setAge(initial.age);
    } else {
      setType(EQUIPMENT_TYPES[0]);
      setQrSlug("");
      setShortDesc("");
      setBrand("");
      setModel("");
      setEnergy(EQUIPMENT_ENERGY[0]);
      setLongDesc("");
      setFeatures("");
      setCondition("");
      setIssues("");
      setAge("");
    }
  }, [open, mode, initial]);

  const typeItems = useMemo(
    () =>
      EQUIPMENT_TYPES.map((str) => ({
        label: str,
        value: str,
      })),
    []
  );

  const typeCollection = useMemo(
    () => createListCollection({ items: typeItems }),
    [typeItems]
  );

  const energyItems = useMemo(
    () =>
      EQUIPMENT_ENERGY.map((str) => ({
        label: str,
        value: str,
      })),
    []
  );

  const energyCollection = useMemo(
    () => createListCollection({ items: energyItems }),
    [energyItems]
  );

  function ableToSave() {
    return type && qrSlug && shortDesc && brand && model && energy;
  }

  async function handleSave() {
    const payload = {
      type: (type ?? "").trim(),
      qrSlug: (qrSlug ?? "").trim(),
      shortDesc: (shortDesc ?? "").trim(),
      brand: (brand ?? "").trim(),
      model: (model ?? "").trim(),
      energy: (energy ?? "").trim(),
      longDesc: (longDesc ?? "").trim(),
      features: (features ?? "").trim(),
      condition: (condition ?? "").trim(),
      issues: (issues ?? "").trim(),
      age: (age ?? "").trim(),
    };

    setBusy(true);
    try {
      let saved;
      if (mode === "create") {
        saved = await apiPost<Equipment>("/api/admin/equipment", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Equipment “${payload.type}” created.`,
          autoHideMs: 3500,
        });
      } else {
        if (!initial?.id) {
          throw new Error("Missing equipment id for update");
        }
        saved = await apiPatch<Equipment>(
          `/api/admin/equipment/${initial.id}`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Equipment updated successfully.`,
          autoHideMs: 3500,
        });
      }
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "create"
            ? "Create equipment failed"
            : "Update equipment failed",
          err
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      role="dialog"
      open={open}
      initialFocusEl={() => cancelRef.current}
      onOpenChange={(e) => onOpenChange(e.open)}
    >
      <Portal>
        <Dialog.Backdrop zIndex={1500} />
        <Dialog.Positioner zIndex={1600}>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {mode === "create" ? "Create Equipment" : "Update Equipment"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Type *</Text>
                  <Select.Root
                    collection={typeCollection}
                    value={[type]}
                    onValueChange={(e) => setType(e.value[0] as EquipmentType)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select a type" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {typeItems.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </div>
                <div>
                  <Text mb="1">QR Slug / ID *</Text>
                  <Input
                    value={qrSlug}
                    onChange={(e) => setQrSlug(e.target.value)}
                    placeholder="QR Slug / ID"
                    aria-label="ID / QRSlug"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <Text mb="1">Summary *</Text>
                  <Input
                    value={shortDesc}
                    onChange={(e) => setShortDesc(e.target.value)}
                    placeholder="Summary"
                    aria-label="Summary"
                    required
                  />
                </div>
                <div>
                  <Text mb="1">Brand *</Text>
                  <Input
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Brand"
                    aria-label="Brand"
                    required
                  />
                </div>
                <div>
                  <Text mb="1">Model *</Text>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Model"
                    aria-label="Model"
                    required
                  />
                </div>
                <div>
                  <Text mb="1">Energy *</Text>
                  <Select.Root
                    collection={energyCollection}
                    value={[energy]}
                    onValueChange={(e) =>
                      setEnergy(e.value[0] as EquipmentEnergy)
                    }
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select energy" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {energyItems.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </div>
                <div>
                  <Text mb="1">Details</Text>
                  <Input
                    value={longDesc}
                    onChange={(e) => setLongDesc(e.target.value)}
                    placeholder="Details"
                    aria-label="Details"
                  />
                </div>
                <div>
                  <Text mb="1">Features</Text>
                  <Input
                    value={features}
                    onChange={(e) => setFeatures(e.target.value)}
                    placeholder="Features"
                    aria-label="Features"
                  />
                </div>
                <div>
                  <Text mb="1">Condition</Text>
                  <Input
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    placeholder="Condition"
                    aria-label="Condition"
                  />
                </div>
                <div>
                  <Text mb="1">Issues</Text>
                  <Input
                    value={issues}
                    onChange={(e) => setIssues(e.target.value)}
                    placeholder="Issues"
                    aria-label="Issues"
                  />
                </div>
                <div>
                  <Text mb="1">Age</Text>
                  <Input
                    value={age}
                    onChange={(e) => setAge(e.target.value)}
                    placeholder="Age"
                    aria-label="Age"
                  />
                </div>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap="2">
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  loading={busy}
                  disabled={!ableToSave()}
                >
                  {actionLabel ?? (mode === "create" ? "Create" : "Save")}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
