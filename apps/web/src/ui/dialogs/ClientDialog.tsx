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
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiPost, apiPatch } from "@/src/lib/api";
import {
  Role,
  DialogMode,
  Client,
  ClientStatus,
  ClientKind,
  CLIENT_KIND,
  CLIENT_STATUS,
} from "@/src/lib/types";
import { prettyStatus } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  role: Role;
  initial?: Client | null;
  onSaved?: (saved: any) => void;
};

export default function ClientDialog({
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
  const [statusValue, setStatusValue] = useState<string[]>([CLIENT_STATUS[0]]);
  const [kindValue, setKindValue] = useState<string[]>([CLIENT_KIND[0]]);

  const [displayName, setDisplayName] = useState("");
  const [notesInternal, setNotesInternal] = useState("");

  const statusItems = useMemo(
    () =>
      CLIENT_STATUS.map((s) => ({
        label: prettyStatus(s),
        value: s,
      })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  const kindItems = useMemo(
    () =>
      CLIENT_KIND.map((s) => ({
        label: prettyStatus(s),
        value: s,
      })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  function ableToSave() {
    return displayName && statusValue && kindValue;
  }

  // seed form when opening/switching modes/records
  useEffect(() => {
    if (!open) return;
    if (mode === "UPDATE" && initial) {
      setKindValue([initial.type ?? CLIENT_KIND[0]]);
      setStatusValue([initial.status ?? CLIENT_STATUS[0]]);
      setDisplayName(initial.displayName ?? "");
      setNotesInternal(initial.notesInternal ?? "");
    } else {
      setKindValue([CLIENT_KIND[0]]);
      setStatusValue([CLIENT_STATUS[0]]);
      setDisplayName("");
      setNotesInternal("");
    }
  }, [open, mode, initial]);

  async function handleSave() {
    if (!displayName.trim()) {
      publishInlineMessage({
        type: "WARNING",
        text: "Please enter a client display name.",
      });
      return;
    }

    const payload = {
      kind: (kindValue[0] as ClientKind) ?? CLIENT_KIND[0],
      status: (statusValue[0] as ClientStatus) ?? CLIENT_STATUS[0],
      displayName: displayName.trim(),
      notesInternal: notesInternal || null,
    };

    setBusy(true);
    try {
      let saved: Client;
      if (mode === "CREATE") {
        saved = await apiPost<Client>("/api/admin/clients", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Client “${payload.displayName}” created.`,
        });
      } else {
        if (!initial?.id) throw new Error("Missing client id");
        saved = await apiPatch<Client>(
          `/api/admin/clients/${initial.id}`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Client “${payload.displayName}” updated.`,
        });
      }
      onSaved?.(saved);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "CREATE" ? "Create client failed" : "Update client failed",
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
                {mode === "CREATE" ? "Create Client" : "Update Client"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Client display name *</Text>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g., John Smith"
                  />
                </div>
                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Status *</Text>
                    <Select.Root
                      collection={statusCollection}
                      value={statusValue}
                      onValueChange={(e) => setStatusValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                      disabled={!isAdmin && mode === "UPDATE"}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select status" />
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
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Kind *</Text>
                    <Select.Root
                      collection={kindCollection}
                      value={kindValue}
                      onValueChange={(e) => setKindValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                      disabled={!isAdmin && mode === "UPDATE"}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select kind" />
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
                </HStack>
                <div>
                  <Text mb="1">Notes</Text>
                  <Textarea
                    value={notesInternal}
                    onChange={(e) => setNotesInternal(e.target.value)}
                    placeholder=""
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
