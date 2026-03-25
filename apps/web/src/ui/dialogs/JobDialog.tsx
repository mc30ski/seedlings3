"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
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
  initial?: Pick<JobListItem, "id" | "propertyId" | "kind" | "status" | "frequencyDays" | "notes" | "defaultPrice"> | null;
  onSaved?: (created?: { id: string; defaultPrice?: number | null; notes?: string | null; frequencyDays?: number | null; estimatedMinutes?: number | null }) => void;
  defaultPropertyId?: string;
};

export default function JobDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSaved,
  defaultPropertyId,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);

  const [properties, setProperties] = useState<PropertyLite[]>([]);
  const [propertyValue, setPropertyValue] = useState<string[]>([]);
  const [kindValue, setKindValue] = useState<string[]>([JOB_KIND[0]]);
  const [statusValue, setStatusValue] = useState<string[]>([JOB_STATUS[0]]);
  const [frequencyDays, setFrequencyDays] = useState("");
  const [notes, setNotes] = useState("");
  const [defaultPrice, setDefaultPrice] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");

  // Load active properties when dialog opens
  useEffect(() => {
    if (!open) return;
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

  // Seed form state
  useEffect(() => {
    if (!open) return;
    if (mode === "UPDATE" && initial) {
      setPropertyValue([initial.propertyId]);
      setKindValue([initial.kind]);
      setStatusValue([initial.status]);
      setFrequencyDays(initial.frequencyDays != null ? String(initial.frequencyDays) : "");
      setNotes(initial.notes ?? "");
      setDefaultPrice(initial.defaultPrice != null ? String(initial.defaultPrice) : "");
      setEstimatedMinutes((initial as any).estimatedMinutes != null ? String((initial as any).estimatedMinutes) : "");
    } else {
      setPropertyValue(defaultPropertyId ? [defaultPropertyId] : []);
      setKindValue([JOB_KIND[0]]);
      setStatusValue([JOB_STATUS[0]]);
      setFrequencyDays("");
      setNotes("");
      setDefaultPrice("");
      setEstimatedMinutes("");
    }
  }, [open, mode, initial, defaultPropertyId]);

  const propertyItems = useMemo(() => {
    const items = properties.map((p) => {
      const location = [p.city, p.state].filter(Boolean).join(", ");
      const parts = [p.displayName];
      if (location) parts.push(location);
      if (p.client?.displayName) parts.push(`(${clientLabel(p.client.displayName)})`);
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
      notes: notes.trim() || null,
      defaultPrice: defaultPrice !== "" ? Number(defaultPrice) : null,
      estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : null,
    };
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
        publishInlineMessage({ type: "SUCCESS", text: "Job updated." });
        onOpenChange(false);
        onSaved?.();
      }
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "CREATE" ? "Create job failed." : "Update job failed.",
          err
        ),
      });
    } finally {
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

                <HStack gap={3} align="flex-end">
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Default price</Text>
                    <CurrencyInput
                      value={defaultPrice}
                      onChange={setDefaultPrice}
                      size="sm"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Frequency (days)</Text>
                    <Input
                      type="number"
                      value={frequencyDays}
                      onChange={(e) => setFrequencyDays(e.target.value)}
                      placeholder="e.g. 14"
                      min={1}
                      size="sm"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Est. minutes</Text>
                    <Input
                      type="number"
                      value={estimatedMinutes}
                      onChange={(e) => setEstimatedMinutes(e.target.value)}
                      placeholder="e.g. 45"
                      min={1}
                      size="sm"
                    />
                  </div>
                </HStack>

                <div>
                  <Text mb="1">Notes</Text>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Internal notes for this job…"
                    rows={3}
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
