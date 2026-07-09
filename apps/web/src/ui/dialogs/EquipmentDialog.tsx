"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { AlertCircle } from "lucide-react";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
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
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import EquipmentPhotos from "@/src/ui/components/EquipmentPhotos";
import EquipmentInstructionsDialog from "@/src/ui/dialogs/EquipmentInstructionsDialog";
import type { EquipmentInstruction } from "@/src/lib/types";

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
  const dlgErr = useDialogError();

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
  const [dailyRate, setDailyRate] = useState("");
  // Per-job + per-day-cap billing knob. Empty string = legacy flat-daily
  // billing. A positive integer engages the new model: contractors pay
  // (dailyRate / equivalentJobs) per formal-crew or solo job completed
  // while the equipment is checked out, capped at dailyRate per day.
  const [equivalentJobs, setEquivalentJobs] = useState("");
  // Per-piece policy-doc requirements — see Equipment.requiredPolicyIds
  // in schema. `attachablePolicies` lists non-archived BLOCK policies whose
  // gatesServices includes RESERVE_EQUIPMENT (the eligibility flag).
  // Toggling a row here updates requiredPolicyIds; it saves with the rest
  // of the form.
  const [requiredPolicyIds, setRequiredPolicyIds] = useState<string[]>([]);
  const [attachablePolicies, setAttachablePolicies] = useState<
    Array<{
      id: string;
      title: string;
      description: string | null;
      workerAction: string;
      targetWorkerTypes: string[];
    }>
  >([]);
  const [attachablePoliciesLoaded, setAttachablePoliciesLoaded] = useState(false);
  const [instructions, setInstructions] = useState<EquipmentInstruction[]>([]);
  const [instructionsDialogOpen, setInstructionsDialogOpen] = useState(false);
  // After CREATE saves successfully, hold the new id so the dialog stays open
  // to allow photo / instruction management without closing & reopening.
  const [createdId, setCreatedId] = useState<string | null>(null);

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
      setDailyRate(initial.dailyRate != null ? initial.dailyRate.toFixed(2) : "");
      setEquivalentJobs((initial as any).equivalentJobs != null ? String((initial as any).equivalentJobs) : "");
      setRequiredPolicyIds(Array.isArray((initial as any).requiredPolicyIds) ? (initial as any).requiredPolicyIds : []);
      setInstructions(initial.instructions ?? []);
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
      setDailyRate("");
      setEquivalentJobs("");
      setRequiredPolicyIds([]);
      setInstructions([]);
    }
    if (open) setCreatedId(null);
  }, [open, mode, initial]);

  // Fetch the list of policies that can be attached to equipment. Fires
  // once per dialog open — an admin who adds a new eligible policy mid-
  // session will need to close and reopen this dialog to see it.
  useEffect(() => {
    if (!open) return;
    setAttachablePoliciesLoaded(false);
    apiGet<typeof attachablePolicies>("/api/admin/policies/attachable-to-equipment")
      .then((rows) => setAttachablePolicies(rows))
      .catch(() => setAttachablePolicies([]))
      .finally(() => setAttachablePoliciesLoaded(true));
  }, [open]);

  function toggleRequiredPolicy(id: string) {
    setRequiredPolicyIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  async function handleSave() {
    dlgErr.clear();
    const payload = {
      type: (type[0] as EquipmentKind) ?? EQUIPMENT_KIND[0],
      qrSlug: qrSlug,
      brand: brand,
      model: model,
      shortDesc: shortDesc,
      longDesc: longDesc,
      energy: (energy[0] as EquipmentEnergy) ?? EQUIPMENT_ENERGY[0],
      features: features,
      condition: condition,
      issues: issues,
      age: age,
      dailyRate: dailyRate ? parseFloat(dailyRate) : null,
      // Cast to int; empty string / NaN / non-positive sends null, which
      // means "flat-daily billing" on the server.
      equivalentJobs: equivalentJobs && parseInt(equivalentJobs, 10) > 0
        ? parseInt(equivalentJobs, 10)
        : null,
      requiredPolicyIds,
    };

    setBusy(true);
    try {
      let saved: Equipment;
      // Effectively UPDATE if we have an id (either from initial or just-created).
      const existingId = initial?.id ?? createdId;
      if (mode === "CREATE" && !existingId) {
        saved = await apiPost<Equipment>("/api/admin/equipment", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Equipment “${payload.shortDesc}” created. Reopen the row to add photos or instructions.`,
        });
        setCreatedId(saved.id);
      } else {
        if (!existingId) throw new Error("Missing equipment id");
        saved = await apiPatch<Equipment>(
          `/api/admin/equipment/${existingId}`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Equipment “${payload.shortDesc}” updated.`,
        });
      }
      onSaved?.(saved);
    } catch (err) {
      dlgErr.setError(
        getErrorMessage(
          mode === "CREATE"
            ? "Create equipment failed"
            : "Update equipment failed",
          err
        )
      );
    } finally {
      // Close on both CREATE and UPDATE. The old "stay open after CREATE so
      // the user can manage photos/instructions" behavior was intentional
      // but surprised admins who expected the dialog to close like every
      // other form. To restore the stay-open behavior, the previous code
      // guarded onOpenChange(false) with a `didCreate` flag; just re-add
      // that flag if you want it back.
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
                {mode === "CREATE" ? "Create Equipment" : "Update Equipment"}
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
                {isAdmin && (
                  <>
                    <div>
                      <Text mb="1">Contractor Rate ($/day)</Text>
                      <CurrencyInput
                        value={dailyRate}
                        onChange={setDailyRate}
                        size="sm"
                        placeholder="0.00 (no charge)"
                      />
                      <Text fontSize="xs" color="fg.muted" mt="1">
                        Only contractors are charged for equipment usage. Employees and trainees use equipment at no cost (covered by their business margin).
                      </Text>
                    </div>
                    <div>
                      <Text mb="1">Equivalent Jobs / Day</Text>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        size="sm"
                        value={equivalentJobs}
                        onChange={(e) => setEquivalentJobs(e.target.value)}
                        placeholder="Leave blank for flat daily rate"
                      />
                      <Text fontSize="xs" color="fg.muted" mt="1">
                        When set, contractors are charged per job instead of per
                        day, with the daily rate as the cap. Per-job rate ={" "}
                        {dailyRate && equivalentJobs && parseInt(equivalentJobs, 10) > 0
                          ? `$${(parseFloat(dailyRate) / parseInt(equivalentJobs, 10)).toFixed(2)}/job`
                          : "(set rate + jobs to preview)"}
                        . On a day with N jobs and equivalent {equivalentJobs || "X"}, contractor pays
                        {" "}min(N × per-job, daily rate). Leave blank to keep
                        flat-daily billing for this piece.
                      </Text>
                    </div>
                    {/* Per-piece policy requirements. Workers reserving this
                        equipment must have a current signature on every
                        checked policy. Only policies with enforcement =
                        Block AND "Claim equipment" gate toggled show up
                        here (they're the ones eligible for attachment). */}
                    <div>
                      <Text mb="1">Required policies to claim this equipment</Text>
                      {!attachablePoliciesLoaded ? (
                        <Text fontSize="xs" color="fg.muted">Loading…</Text>
                      ) : attachablePolicies.length === 0 ? (
                        <Box
                          p={2}
                          borderWidth="1px"
                          borderRadius="md"
                          bg="gray.50"
                        >
                          <Text fontSize="xs" color="fg.muted">
                            No policies are eligible to attach. To make one eligible,
                            go to Directory → Compliance, open the policy, set
                            enforcement to <b>Block</b>, and toggle{" "}
                            <b>Claim equipment</b> under "What this blocks".
                          </Text>
                        </Box>
                      ) : (
                        <VStack align="stretch" gap={1} borderWidth="1px" borderRadius="md" p={2}>
                          {attachablePolicies.map((p) => {
                            const checked = requiredPolicyIds.includes(p.id);
                            return (
                              <HStack
                                key={p.id}
                                gap={2}
                                p={2}
                                borderRadius="md"
                                cursor="pointer"
                                bg={checked ? "red.50" : undefined}
                                _hover={{ bg: checked ? "red.100" : "gray.50" }}
                                onClick={() => toggleRequiredPolicy(p.id)}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleRequiredPolicy(p.id)}
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <VStack align="start" gap={0} flex="1" minW={0}>
                                  <HStack gap={2} wrap="wrap">
                                    <Text fontSize="sm" fontWeight="medium">
                                      {p.title}
                                    </Text>
                                    <Badge size="xs" colorPalette="red" variant="subtle">
                                      Block
                                    </Badge>
                                    {p.targetWorkerTypes.length > 0 && (
                                      <Text fontSize="2xs" color="fg.muted">
                                        {p.targetWorkerTypes.join(", ")}
                                      </Text>
                                    )}
                                  </HStack>
                                  {p.description && (
                                    <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                                      {p.description}
                                    </Text>
                                  )}
                                </VStack>
                              </HStack>
                            );
                          })}
                        </VStack>
                      )}
                    </div>
                  </>
                )}
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
                {isAdmin && (() => {
                  const equipId = initial?.id ?? createdId;
                  return (
                    <div>
                      <HStack justify="space-between" alignItems="center" mb="1">
                        <Text fontSize="sm" fontWeight="medium">Instructions</Text>
                        <Button size="xs" variant="outline" disabled={!equipId} onClick={() => setInstructionsDialogOpen(true)}>
                          Manage Instructions
                        </Button>
                      </HStack>
                      {!equipId ? (
                        <Text fontSize="xs" color="fg.muted">Save the equipment first to add instructions.</Text>
                      ) : instructions.length > 0 ? (
                        <Box px="3" py="1.5" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                          <VStack align="stretch" gap="0.5">
                            {instructions.map((inst) => (
                              <HStack key={inst.id} gap="1.5" align="center">
                                <AlertCircle
                                  size={18}
                                  color="var(--chakra-colors-yellow-900)"
                                  fill="var(--chakra-colors-yellow-400)"
                                  strokeWidth={2.5}
                                />
                                <Text fontSize="xs" fontWeight="semibold" color="yellow.700">
                                  {inst.text}
                                </Text>
                              </HStack>
                            ))}
                          </VStack>
                        </Box>
                      ) : (
                        <Text fontSize="xs" color="fg.muted">No instructions set.</Text>
                      )}
                    </div>
                  );
                })()}
                {(() => {
                  const equipId = initial?.id ?? createdId;
                  return (
                    <div>
                      <Text mb="1" fontSize="sm" fontWeight="medium">Photos</Text>
                      {equipId ? (
                        <EquipmentPhotos equipmentId={equipId} />
                      ) : (
                        <Text fontSize="xs" color="fg.muted">Save the equipment first to add photos.</Text>
                      )}
                    </div>
                  );
                })()}
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  {createdId ? "Done" : "Cancel"}
                </Button>
                <Button
                  onClick={handleSave}
                  loading={busy}
                  disabled={!ableToSave()}
                >
                  {mode === "CREATE" && !createdId ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
      {(initial?.id || createdId) && isAdmin && (
        <EquipmentInstructionsDialog
          open={instructionsDialogOpen}
          onOpenChange={setInstructionsDialogOpen}
          equipmentId={(initial?.id ?? createdId)!}
          currentInstructions={instructions}
          onSaved={(updated) => {
            setInstructions(updated);
            // Trigger parent reload so cards show the new instructions immediately
            // (they're already persisted via the inner dialog's API calls).
            if (initial) onSaved?.({ ...initial, instructions: updated });
          }}
        />
      )}
    </Dialog.Root>
  );
}
