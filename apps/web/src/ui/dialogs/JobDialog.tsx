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
import { prettyStatus } from "@/src/lib/lib";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";

type PropertyLite = {
  id: string;
  displayName: string;
  city?: string | null;
  state?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  initial?: Pick<JobListItem, "id" | "propertyId" | "kind" | "status" | "notes" | "defaultPrice"> | null;
  onSaved?: () => void;
};

export default function JobDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);

  const [properties, setProperties] = useState<PropertyLite[]>([]);
  const [propertyValue, setPropertyValue] = useState<string[]>([]);
  const [kindValue, setKindValue] = useState<string[]>([JOB_KIND[0]]);
  const [statusValue, setStatusValue] = useState<string[]>([JOB_STATUS[0]]);
  const [notes, setNotes] = useState("");
  const [defaultPrice, setDefaultPrice] = useState("");

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
      setNotes(initial.notes ?? "");
      setDefaultPrice(initial.defaultPrice != null ? String(initial.defaultPrice) : "");
    } else {
      setPropertyValue([]);
      setKindValue([JOB_KIND[0]]);
      setStatusValue([JOB_STATUS[0]]);
      setNotes("");
      setDefaultPrice("");
    }
  }, [open, mode, initial]);

  const propertyItems = useMemo(() => {
    const items = properties.map((p) => ({
      label: [p.displayName, p.city, p.state].filter(Boolean).join(", "),
      value: p.id,
    }));
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
      notes: notes.trim() || null,
      defaultPrice: defaultPrice !== "" ? Number(defaultPrice) : null,
    };
    setBusy(true);
    try {
      if (mode === "CREATE") {
        await apiPost("/api/admin/jobs", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Job created." });
      } else {
        if (!initial?.id) throw new Error("Missing job id");
        await apiPatch(`/api/admin/jobs/${initial.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Job updated." });
      }
      onSaved?.();
      onOpenChange(false);
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
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      value={defaultPrice}
                      onChange={(e) => setDefaultPrice(e.target.value)}
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
