"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Repeat, X } from "lucide-react";
import { apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

const PRESETS = [
  "Cut shorter",
  "Cut longer",
  "Skip backyard",
  "Skip front yard",
  "Bag clippings",
  "Double cut",
  "Edge only",
  "Blow only",
  "Watch for pet",
  "Gate code changed",
  "Client home — knock first",
  "Client not home — proceed",
];

type Instruction = {
  id: string;
  text: string;
  isPreset: boolean;
  repeats: boolean;
  sortOrder: number;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  currentInstructions?: Instruction[];
  onSaved?: (instructions: Instruction[]) => void;
};

export default function PinnedNoteDialog({
  open,
  onOpenChange,
  occurrenceId,
  currentInstructions,
  onSaved,
}: Props) {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [customText, setCustomText] = useState("");
  const [newRepeats, setNewRepeats] = useState(true);

  useEffect(() => {
    if (open) {
      setInstructions(currentInstructions ?? []);
      setCustomText("");
      setNewRepeats(true);
    }
  }, [open, currentInstructions]);

  const usedPresets = new Set(instructions.filter((i) => i.isPreset).map((i) => i.text));

  async function addPreset(text: string) {
    try {
      const created = await apiPost<Instruction>(`/api/occurrences/${occurrenceId}/instructions`, {
        text,
        isPreset: true,
        repeats: newRepeats,
      });
      setInstructions((prev) => [...prev, created]);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add.", err) });
    }
  }

  async function addCustom() {
    if (!customText.trim()) return;
    try {
      const created = await apiPost<Instruction>(`/api/occurrences/${occurrenceId}/instructions`, {
        text: customText.trim(),
        isPreset: false,
        repeats: newRepeats,
      });
      setInstructions((prev) => [...prev, created]);
      setCustomText("");
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add.", err) });
    }
  }

  async function removeInstruction(id: string) {
    try {
      await apiDelete(`/api/occurrences/${occurrenceId}/instructions/${id}`);
      setInstructions((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove.", err) });
    }
  }

  async function toggleRepeats(id: string, current: boolean) {
    try {
      await apiPatch(`/api/occurrences/${occurrenceId}/instructions/${id}`, { repeats: !current });
      setInstructions((prev) => prev.map((i) => i.id === id ? { ...i, repeats: !current } : i));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to update.", err) });
    }
  }

  function handleClose() {
    onSaved?.(instructions);
    onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) handleClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg" maxH="80vh" overflowY="auto">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Manage Instructions</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {instructions.length > 0 && (
                  <VStack align="stretch" gap={1}>
                    {instructions.map((inst) => (
                      <HStack key={inst.id} gap={2} p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md" align="center">
                        <Text fontSize="sm" flex="1">{inst.text}</Text>
                        <Button
                          size="xs"
                          variant="ghost"
                          px="1"
                          minW="0"
                          title={inst.repeats ? "Carries forward — click to make one-time" : "One-time — click to carry forward"}
                          onClick={() => void toggleRepeats(inst.id, inst.repeats)}
                        >
                          <Repeat size={12} color={inst.repeats ? "var(--chakra-colors-blue-500)" : "var(--chakra-colors-gray-300)"} />
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          colorPalette="red"
                          px="1"
                          minW="0"
                          onClick={() => void removeInstruction(inst.id)}
                        >
                          <X size={12} />
                        </Button>
                      </HStack>
                    ))}
                  </VStack>
                )}

                {instructions.length === 0 && (
                  <Text fontSize="sm" color="fg.muted">No instructions yet. Add presets or custom instructions below.</Text>
                )}

                <Checkbox.Root
                  checked={newRepeats}
                  onCheckedChange={(e) => setNewRepeats(!!e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontSize="sm">Carry forward new instructions to future occurrences</Checkbox.Label>
                </Checkbox.Root>

                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Quick add</Text>
                  <Box display="flex" gap="4px" flexWrap="wrap">
                    {PRESETS.filter((p) => !usedPresets.has(p)).map((preset) => (
                      <Badge
                        key={preset}
                        size="sm"
                        colorPalette="yellow"
                        variant="outline"
                        cursor="pointer"
                        px="2"
                        borderRadius="full"
                        _hover={{ bg: "yellow.100" }}
                        onClick={() => void addPreset(preset)}
                      >
                        + {preset}
                      </Badge>
                    ))}
                    {PRESETS.filter((p) => !usedPresets.has(p)).length === 0 && (
                      <Text fontSize="xs" color="fg.muted">All presets added</Text>
                    )}
                  </Box>
                </Box>

                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Custom instruction</Text>
                  <HStack gap={2}>
                    <Input
                      size="sm"
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                      placeholder="e.g., Check irrigation timer"
                      onKeyDown={(e) => { if (e.key === "Enter") void addCustom(); }}
                    />
                    <Button size="sm" colorPalette="yellow" disabled={!customText.trim()} onClick={() => void addCustom()}>
                      Add
                    </Button>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={handleClose}>Done</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
