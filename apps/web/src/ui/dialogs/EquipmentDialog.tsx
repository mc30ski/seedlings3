"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Badge,
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
  Role,
  DialogMode,
  Equipment,
  EQUIPMENT_KIND,
  EQUIPMENT_ENERGY,
  EquipmentKind,
  EquipmentEnergy,
} from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  role: Role;
  initial?: Equipment | null;
  onSaved?: (saved: any) => void;
};

export default function EquipmentDialog({
  open,
  onOpenChange,
  mode,
  role,
  initial,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const isAdmin = role === "ADMIN";
  const [busy, setBusy] = useState(false);

  // --- Form state
  const [type, setType] = useState<string[]>([EQUIPMENT_KIND[0]]);
  const [qrSlug, setQrSlug] = useState("");
  const [shortDesc, setShortDesc] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [energy, setEnergy] = useState<string[]>([EQUIPMENT_ENERGY[0]]);
  const [longDesc, setLongDesc] = useState<string | undefined>("");
  const [features, setFeatures] = useState<string | undefined>("");
  const [condition, setCondition] = useState<string | undefined>("");
  const [issues, setIssues] = useState<string | undefined>("");
  const [age, setAge] = useState<string | undefined>("");

  const typeItems = useMemo(
    () =>
      EQUIPMENT_KIND.map((str) => ({
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

  // seed form when opening/switching modes/records
  useEffect(() => {
    if (!open) return;
    if (mode === "UPDATE" && initial) {
      setType([initial.type ?? EQUIPMENT_KIND[0]]);
      setQrSlug(initial.qrSlug ?? "");
      setShortDesc(initial.shortDesc ?? "");
      setBrand(initial.brand ?? "");
      setModel(initial.model ?? "");
      setEnergy([initial.energy ?? EQUIPMENT_ENERGY[0]]);
      setLongDesc(initial.longDesc ?? "");
      setFeatures(initial.features ?? "");
      setCondition(initial.condition ?? "");
      setIssues(initial.issues ?? "");
      setAge(initial.age ?? "");
    } else {
      setType([EQUIPMENT_KIND[0]]);
      setQrSlug("");
      setShortDesc("");
      setBrand("");
      setModel("");
      setEnergy([EQUIPMENT_ENERGY[0]]);
      setLongDesc("");
      setFeatures("");
      setCondition("");
      setIssues("");
      setAge("");
    }
  }, [open, mode, initial]);

  async function handleSave() {
    const payload = {
      type: (type[0] as EquipmentKind) ?? EQUIPMENT_KIND[0],
      qrSlug: qrSlug,
      brand: brand,
      model: model,
      shortDesc: shortDesc,
      longDesc: longDesc,
      energy: (type[0] as EquipmentEnergy) ?? EQUIPMENT_ENERGY[0],
      features: features,
      condition: condition,
      issues: issues,
      age: age,
    };

    setBusy(true);
    try {
      let saved: Equipment;
      if (mode === "CREATE") {
        saved = await apiPost<Equipment>("/api/admin/equipment", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Property “${payload.shortDesc}” created.`,
        });
      } else {
        if (!initial?.id) throw new Error("Missing equipment id");
        saved = await apiPatch<Equipment>(
          `/api/admin/equipment/${initial.id}`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Property “${payload.shortDesc}” updated.`,
        });
      }
      onSaved?.(saved);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "CREATE"
            ? "Create equipment failed"
            : "Update equipment failed",
          err
        ),
      });
    } finally {
      onOpenChange(false);
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            mx="4"
            maxW="lg"
            w="full"
            rounded="2xl"
            p="4"
            shadow="lg"
          >
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {mode === "CREATE" ? "Create Property" : "Update Property"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <HStack justify="space-between">
                    <Text mb="1">Type *</Text>
                    {!isAdmin && <Badge colorPalette="gray">Read-only</Badge>}
                  </HStack>
                  <Select.Root
                    collection={typeCollection}
                    value={type}
                    onValueChange={(e) => setType(e.value)}
                    size="sm"
                    positioning={{
                      strategy: "fixed",
                      hideWhenDetached: true,
                    }}
                    disabled={!isAdmin && mode === "UPDATE"}
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
                    placeholder="QR Slug"
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Summary *</Text>
                  <Input
                    value={shortDesc}
                    onChange={(e) => setShortDesc(e.target.value)}
                    placeholder="Summary"
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Brand *</Text>
                  <Input
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Brand"
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Model *</Text>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Model"
                    mb="2"
                  />
                </div>
                <div>
                  <HStack justify="space-between">
                    <Text mb="1">Energy *</Text>
                  </HStack>
                  <Select.Root
                    collection={energyCollection}
                    value={energy}
                    onValueChange={(e) => setEnergy(e.value)}
                    size="sm"
                    positioning={{
                      strategy: "fixed",
                      hideWhenDetached: true,
                    }}
                    disabled={!isAdmin && mode === "UPDATE"}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select a type" />
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
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Features</Text>
                  <Input
                    value={features}
                    onChange={(e) => setFeatures(e.target.value)}
                    placeholder="Features"
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Condition</Text>
                  <Input
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    placeholder="Condition"
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Issues</Text>
                  <Input
                    value={issues}
                    onChange={(e) => setIssues(e.target.value)}
                    placeholder="Issues"
                    mb="2"
                  />
                </div>
                <div>
                  <Text mb="1">Age</Text>
                  <Input
                    value={age}
                    onChange={(e) => setAge(e.target.value)}
                    placeholder="Age"
                    mb="2"
                  />
                </div>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
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
                  {mode === "CREATE" ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
