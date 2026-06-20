"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet, apiPatch, apiPost, apiPut } from "@/src/lib/api";
import {
  type DialogMode,
  type JobKind,
  type JobListItem,
  type JobStatus,
  JOB_KIND,
  JOB_STATUS,
} from "@/src/lib/types";
import { prettyStatus, clientLabel } from "@/src/lib/lib";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

type PropertyLite = {
  id: string;
  displayName: string;
  city?: string | null;
  state?: string | null;
  client?: { id: string; displayName: string } | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  initial?: Pick<JobListItem, "id" | "propertyId" | "kind" | "status" | "frequencyDays" | "description" | "notes" | "defaultPrice"> | null;
  onSaved?: (created?: { id: string; defaultPrice?: number | null; notes?: string | null; frequencyDays?: number | null; estimatedMinutes?: number | null }) => void;
  defaultPropertyId?: string;
  preventOutsideClose?: boolean;
  deferSave?: boolean;
  deferredProperty?: { id: string; displayName: string };
  onBack?: () => void;
};

export default function JobDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSaved,
  defaultPropertyId,
  preventOutsideClose,
  deferSave,
  deferredProperty,
  onBack,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const dlgErr = useDialogError();

  const [properties, setProperties] = useState<PropertyLite[]>([]);
  const [propertyValue, setPropertyValue] = useState<string[]>([]);
  const [kindValue, setKindValue] = useState<string[]>([JOB_KIND[0]]);
  // New jobs default to ACCEPTED — most jobs created via the New Job
  // workflow are already verbally agreed-to. Editing an existing job
  // reflects its actual status (see the UPDATE branch below).
  const [statusValue, setStatusValue] = useState<string[]>(["ACCEPTED"]);
  const [frequencyDays, setFrequencyDays] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [defaultPrice, setDefaultPrice] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  // Recommended equipment collections — admin can attach kits to a job so
  // workers see them as suggested checkouts on the job/occurrence view.
  type CollectionLite = { id: string; name: string; items: { equipmentId: string }[] };
  const [allCollections, setAllCollections] = useState<CollectionLite[]>([]);
  const [recommendedCollectionIds, setRecommendedCollectionIds] = useState<string[]>([]);
  const [recommendedDirty, setRecommendedDirty] = useState(false);

  // Load active properties when dialog opens
  useEffect(() => {
    if (!open) return;
    if (deferSave && deferredProperty) {
      setProperties([deferredProperty as any]);
      setPropertyValue([deferredProperty.id]);
      return;
    }
    (async () => {
      try {
        const list = await apiGet<PropertyLite[]>(
          "/api/admin/properties?status=ACTIVE&limit=500"
        );
        setProperties(Array.isArray(list) ? list : []);
      } catch {
        setProperties([]);
      }
    })();
  }, [open]);

  // Load all collections for the recommendation picker, and the current
  // recommendations for this job (UPDATE mode only).
  useEffect(() => {
    if (!open) return;
    apiGet<CollectionLite[]>("/api/equipment-collections")
      .then((list) => setAllCollections(Array.isArray(list) ? list : []))
      .catch(() => setAllCollections([]));
    if (mode === "UPDATE" && initial?.id) {
      apiGet<{ collectionId: string }[]>(`/api/admin/jobs/${initial.id}/recommended-collections`)
        .then((rows) => setRecommendedCollectionIds(Array.isArray(rows) ? rows.map((r) => r.collectionId) : []))
        .catch(() => setRecommendedCollectionIds([]));
    } else {
      setRecommendedCollectionIds([]);
    }
    setRecommendedDirty(false);
  }, [open, mode, initial?.id]);

  // Seed form ONCE per open. Re-running on every `initial` reference change
  // would wipe what the user typed whenever the parent re-renders — which
  // can happen often during slow multi-step workflows (tab refocus, /me
  // polls, alert-badge refreshes, Clerk session refreshes). Consumers
  // always close-then-reopen the dialog to switch records, so seed-on-open-
  // only is the right contract.
  const prevOpenRefSeed = useRef(false);
  useEffect(() => {
    if (!open) { prevOpenRefSeed.current = false; return; }
    if (prevOpenRefSeed.current) return;
    prevOpenRefSeed.current = true;
    if (mode === "UPDATE" && initial) {
      setPropertyValue([initial.propertyId]);
      setKindValue([initial.kind]);
      setStatusValue([initial.status]);
      setFrequencyDays(initial.frequencyDays != null ? String(initial.frequencyDays) : "");
      setDescription(initial.description ?? "");
      setNotes(initial.notes ?? "");
      setDefaultPrice(initial.defaultPrice != null ? String(initial.defaultPrice) : "");
      setEstimatedMinutes((initial as any).estimatedMinutes != null ? String((initial as any).estimatedMinutes) : "");
    } else {
      setPropertyValue(defaultPropertyId ? [defaultPropertyId] : []);
      setKindValue([initial?.kind ?? JOB_KIND[0]]);
      setStatusValue([initial?.status ?? "ACCEPTED"]);
      setFrequencyDays(initial?.frequencyDays != null ? String(initial.frequencyDays) : "");
      setDescription(initial?.description ?? "");
      setNotes(initial?.notes ?? "");
      setDefaultPrice(initial?.defaultPrice != null ? String(initial.defaultPrice) : "");
      setEstimatedMinutes((initial as any)?.estimatedMinutes != null ? String((initial as any).estimatedMinutes) : "");
    }
  }, [open]);

  const propertyItems = useMemo(() => {
    const items = properties.map((p) => {
      const location = [p.city, p.state].filter(Boolean).join(", ");
      const parts = [p.displayName];
      if (p.client?.displayName) parts.push(`(${clientLabel(p.client.displayName)})`);
      if (location) parts.push(location);
      return { label: parts.join(" — "), value: p.id };
    });
    const cur = propertyValue[0];
    if (cur && !items.some((i) => i.value === cur)) {
      items.unshift({ label: cur, value: cur });
    }
    return items;
  }, [properties, propertyValue]);
  const propertyCollection = useMemo(
    () => createListCollection({ items: propertyItems }),
    [propertyItems]
  );

  const kindItems = useMemo(
    () => JOB_KIND.map((k) => ({ label: prettyStatus(k), value: k })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  const statusItems = useMemo(
    () => JOB_STATUS.map((s) => ({ label: prettyStatus(s), value: s })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  async function handleSave() {
    dlgErr.clear();
    const pid = propertyValue[0];
    if (!pid) {
      publishInlineMessage({ type: "WARNING", text: "Please select a property." });
      return;
    }
    const payload = {
      propertyId: pid,
      kind: kindValue[0] as JobKind,
      status: statusValue[0] as JobStatus,
      frequencyDays: frequencyDays !== "" ? Number(frequencyDays) : null,
      description: description.trim() || null,
      notes: notes.trim() || null,
      defaultPrice: defaultPrice !== "" ? Number(defaultPrice) : null,
      estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : null,
    };
    if (deferSave) {
      onSaved?.({ id: "__deferred__", ...payload } as any);
      onOpenChange(false);
      return;
    }

    setBusy(true);
    try {
      if (mode === "CREATE") {
        const created = await apiPost<{ id: string }>("/api/admin/jobs", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Job created." });
        onOpenChange(false);
        onSaved?.({
          id: created.id,
          defaultPrice: payload.defaultPrice,
          notes: payload.notes,
          frequencyDays: payload.frequencyDays,
          estimatedMinutes: payload.estimatedMinutes,
        });
      } else {
        if (!initial?.id) throw new Error("Missing job id");
        await apiPatch(`/api/admin/jobs/${initial.id}`, payload);
        // Save recommended collections if changed
        if (recommendedDirty) {
          await apiPut(`/api/admin/jobs/${initial.id}/recommended-collections`, {
            collectionIds: recommendedCollectionIds,
          });
        }
        publishInlineMessage({ type: "SUCCESS", text: "Job updated." });
        onOpenChange(false);
        onSaved?.();
      }
    } catch (err) {
      dlgErr.setError(getErrorMessage(
        mode === "CREATE" ? "Create job failed." : "Update job failed.",
        err
      ));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      closeOnInteractOutside={!preventOutsideClose}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {mode === "CREATE" ? "New Job" : "Edit Job"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Property *</Text>
                  <Select.Root
                    collection={propertyCollection}
                    value={propertyValue}
                    onValueChange={(e) => setPropertyValue(e.value)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select a property" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {propertyItems.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </div>

                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Kind *</Text>
                    <Select.Root
                      collection={kindCollection}
                      value={kindValue}
                      onValueChange={(e) => setKindValue(e.value)}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Kind" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {kindItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>

                  <div style={{ flex: 1 }}>
                    <Text mb="1">Status *</Text>
                    <Select.Root
                      collection={statusCollection}
                      value={statusValue}
                      onValueChange={(e) => setStatusValue(e.value)}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Status" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {statusItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>
                </HStack>

                <div>
                  <Text mb="1">Description</Text>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Description of this job service (visible to workers)…"
                    rows={2}
                  />
                </div>

                <div>
                  <Text mb="1">Default price</Text>
                  <CurrencyInput
                    value={defaultPrice}
                    onChange={setDefaultPrice}
                    size="sm"
                  />
                </div>
                <div>
                  <Text mb="1">Est. minutes</Text>
                  <Input
                    type="number"
                    value={estimatedMinutes}
                    onChange={(e) => setEstimatedMinutes(e.target.value)}
                    placeholder="e.g. 45"
                    min={1}
                    size="sm"
                  />
                  <Box px={2} py={1} mt={1} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                    <Text fontSize="2xs" color="yellow.700">Enter the time as if one person were completing the job alone. The app will automatically adjust the estimate when multiple workers are assigned.</Text>
                  </Box>
                </div>

                <div>
                  <Text mb="1">Default frequency (days)</Text>
                  <Input
                    type="number"
                    value={frequencyDays}
                    onChange={(e) => setFrequencyDays(e.target.value)}
                    placeholder="e.g. 14"
                    min={1}
                    size="sm"
                  />
                  <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md" mt={2}>
                    <Text fontSize="xs" color="yellow.800">
                      This is the default repeat frequency for new occurrences on this job. Individual occurrences can override this with their own frequency.
                    </Text>
                  </Box>
                </div>


                {mode === "UPDATE" && initial?.id && (
                  <div>
                    <Text mb="1">Recommended collections</Text>
                    {allCollections.length === 0 ? (
                      <Text fontSize="xs" color="fg.muted">
                        No equipment collections defined yet. Create some under Inventory → Collections.
                      </Text>
                    ) : (
                      <Box borderWidth="1px" borderRadius="md" p={2} bg="bg.subtle">
                        <HStack flexWrap="wrap" gap={1.5}>
                          {allCollections.map((c) => {
                            const selected = recommendedCollectionIds.includes(c.id);
                            return (
                              <Badge
                                key={c.id}
                                size="md"
                                colorPalette={selected ? "blue" : "gray"}
                                variant={selected ? "solid" : "outline"}
                                cursor="pointer"
                                px={2}
                                py={1}
                                onClick={() => {
                                  setRecommendedCollectionIds((prev) =>
                                    prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                                  );
                                  setRecommendedDirty(true);
                                }}
                              >
                                {c.name} ({c.items.length})
                              </Badge>
                            );
                          })}
                        </HStack>
                        <Text fontSize="xs" color="fg.muted" mt={2}>
                          Workers will see these as suggested collections to grab when starting this job.
                        </Text>
                      </Box>
                    )}
                  </div>
                )}

                <div>
                  <Text mb="1">Internal Notes</Text>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Internal notes (admin only)…"
                    rows={3}
                  />
                </div>
              </VStack>
            </Dialog.Body>

            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                {onBack && <Button variant="outline" onClick={onBack}>Back</Button>}
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
                  disabled={!propertyValue[0]}
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
