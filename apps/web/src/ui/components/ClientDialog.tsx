"use client";

import { useEffect, useMemo, useState } from "react";
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
import { apiPost, apiPatch } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type ClientType = "INDIVIDUAL" | "HOUSEHOLD" | "ORGANIZATION" | "COMMUNITY";

type Client = {
  id: string;
  displayName: string;
  type: ClientType;
  internalNotes?: string | null;
};

type Mode = "create" | "update";

type Props = {
  /** Required: control visibility from the parent */
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /** "create" (no client) or "update" (with initialClient) */
  mode: Mode;

  /** When mode = "update", pass the existing client */
  initialClient?: Client | null;

  /** InlineMessage scope; mount <InlineMessage scope="clients" /> in the tab */
  scope?: string;

  /** Called after successful save with the server payload */
  onSaved?: (saved: any) => void;

  /** Optional button text override on primary action */
  actionLabel?: string;
};

export default function ClientDialog({
  open,
  onOpenChange,
  mode,
  initialClient,
  scope = "clients",
  onSaved,
  actionLabel,
}: Props) {
  const [busy, setBusy] = useState(false);

  // --- Form state
  const [displayName, setDisplayName] = useState("");
  const [typeValue, setTypeValue] = useState<string[]>(["INDIVIDUAL"]);
  const [internalNotes, setInternalNotes] = useState("");

  // Seed form when opened or when switching clients
  useEffect(() => {
    if (!open) return;
    if (mode === "update" && initialClient) {
      setDisplayName(initialClient.displayName ?? "");
      setTypeValue([initialClient.type ?? "INDIVIDUAL"]);
      setInternalNotes(initialClient.internalNotes ?? "");
    } else {
      setDisplayName("");
      setTypeValue(["INDIVIDUAL"]);
      setInternalNotes("");
    }
  }, [open, mode, initialClient]);

  const typeItems = useMemo(
    () => [
      { label: "INDIVIDUAL", value: "INDIVIDUAL" },
      { label: "HOUSEHOLD", value: "HOUSEHOLD" },
      { label: "ORGANIZATION", value: "ORGANIZATION" },
      { label: "COMMUNITY", value: "COMMUNITY" },
    ],
    []
  );

  const typeCollection = useMemo(
    () => createListCollection({ items: typeItems }),
    [typeItems]
  );

  async function handleSave() {
    if (!displayName.trim()) {
      publishInlineMessage({
        scope,
        type: "WARNING",
        text: "Please enter a client name.",
        autoHideMs: 3000,
      });
      return;
    }

    const payload = {
      displayName: displayName.trim(),
      type: (typeValue[0] as ClientType) ?? "INDIVIDUAL",
      notes: internalNotes.trim() || null,
    };

    setBusy(true);
    try {
      let saved;
      if (mode === "create") {
        saved = await apiPost("/api/admin/clients", payload);
        publishInlineMessage({
          scope,
          type: "SUCCESS",
          text: `Client “${payload.displayName}” created.`,
          autoHideMs: 3500,
        });
      } else {
        if (!initialClient?.id) {
          throw new Error("Missing client id for update");
        }
        saved = await apiPatch(
          `/api/admin/clients/${initialClient.id}`,
          payload
        );
        publishInlineMessage({
          scope,
          type: "SUCCESS",
          text: `Client “${payload.displayName}” updated.`,
          autoHideMs: 3500,
        });
      }
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({
        scope,
        type: "ERROR",
        text: getErrorMessage(
          mode === "create" ? "Create client failed" : "Update client failed",
          err
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {mode === "create" ? "Create Client" : "Update Client"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Name</Text>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Client name"
                    autoFocus
                  />
                </div>

                <div>
                  <Text mb="1">Type</Text>
                  <Select.Root
                    collection={typeCollection}
                    value={typeValue}
                    onValueChange={(e) => setTypeValue(e.value)}
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
                  <Text mb="1">Internal notes (optional)</Text>
                  <Textarea
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    placeholder="Notes visible to admins"
                    rows={3}
                  />
                </div>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button onClick={handleSave} loading={busy}>
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
