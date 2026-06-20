"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { X } from "lucide-react";
import { apiPost, apiDelete } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import { type EquipmentInstruction } from "@/src/lib/types";

const PRESETS = [
  "Hard to start",
  "Needs careful priming",
  "Sharp blade — handle with care",
  "Requires special fuel",
  "Battery drains quickly",
  "Wheels stick — clean before use",
  "Loud — wear ear protection",
  "Heavy — two-person carry",
  "Fragile cord/cable",
  "Refuel before returning",
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  equipmentId: string;
  currentInstructions?: EquipmentInstruction[];
  onSaved?: (instructions: EquipmentInstruction[]) => void;
};

export default function EquipmentInstructionsDialog({
  open,
  onOpenChange,
  equipmentId,
  currentInstructions,
  onSaved,
}: Props) {
  const [instructions, setInstructions] = useState<EquipmentInstruction[]>([]);
  const [customText, setCustomText] = useState("");
  const dlgErr = useDialogError();

  useEffect(() => {
    if (open) {
      setInstructions(currentInstructions ?? []);
      setCustomText("");
    }
  }, [open, currentInstructions]);

  const usedPresets = new Set(instructions.filter((i) => i.isPreset).map((i) => i.text));

  async function addPreset(text: string) {
    dlgErr.clear();
    try {
      const created = await apiPost<EquipmentInstruction>(`/api/admin/equipment/${equipmentId}/instructions`, {
        text,
        isPreset: true,
      });
      setInstructions((prev) => [...prev, created]);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to add.", err));
    }
  }

  async function addCustom() {
    dlgErr.clear();
    if (!customText.trim()) return;
    try {
      const created = await apiPost<EquipmentInstruction>(`/api/admin/equipment/${equipmentId}/instructions`, {
        text: customText.trim(),
        isPreset: false,
      });
      setInstructions((prev) => [...prev, created]);
      setCustomText("");
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to add.", err));
    }
  }

  async function removeInstruction(id: string) {
    dlgErr.clear();
    try {
      await apiDelete(`/api/admin/equipment/${equipmentId}/instructions/${id}`);
      setInstructions((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to remove.", err));
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
                      placeholder="e.g., Replace fuel filter quarterly"
                      onKeyDown={(e) => { if (e.key === "Enter") void addCustom(); }}
                    />
                    <Button size="sm" colorPalette="yellow" disabled={!customText.trim()} onClick={() => void addCustom()}>
                      Add
                    </Button>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <Button variant="ghost" onClick={handleClose}>Done</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
