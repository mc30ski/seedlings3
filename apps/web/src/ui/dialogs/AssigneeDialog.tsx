"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Portal,
  Select,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet, apiPut } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

type WorkerLite = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  currentAssignees: JobOccurrenceAssigneeWithUser[];
  onSaved?: () => void;
};

export default function AssigneeDialog({
  open,
  onOpenChange,
  occurrenceId,
  currentAssignees,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setSelected(currentAssignees.map((a) => a.userId));
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>(
          "/api/admin/users?role=WORKER&approved=true"
        );
        setWorkers(Array.isArray(list) ? list : []);
      } catch {
        setWorkers([]);
      }
    })();
  }, [open]);

  const workerItems = useMemo(
    () =>
      workers.map((w) => ({
        label: w.displayName ?? w.email ?? w.id,
        value: w.id,
      })),
    [workers]
  );

  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  async function handleSave() {
    setBusy(true);
    try {
      await apiPut(`/api/admin/occurrences/${occurrenceId}/assignees`, {
        assigneeUserIds: selected,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Assignees updated." });
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update assignees failed.", err),
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
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Manage Assignees</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Assigned workers</Text>
                  <Select.Root
                    collection={workerCollection}
                    value={selected}
                    onValueChange={(e) => setSelected(e.value)}
                    multiple
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText
                          placeholder={
                            workers.length === 0
                              ? "Loading workers…"
                              : "Select workers"
                          }
                        />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {workerItems.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                  <Text fontSize="xs" color="fg.muted" mt="1">
                    Select multiple. Clear all to unassign everyone.
                  </Text>
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
                <Button onClick={handleSave} loading={busy}>
                  Save
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
