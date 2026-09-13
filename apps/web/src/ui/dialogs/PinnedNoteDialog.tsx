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
import { CalendarArrowUp, CalendarCheck, Repeat, X } from "lucide-react";
import { apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";

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

export type InstructionScope = "THIS_VISIT" | "EVERY_VISIT" | "NEXT_VISIT_ONLY";

type Instruction = {
  id: string;
  text: string;
  isPreset: boolean;
  scope: InstructionScope;
  sortOrder: number;
  deliveredAt?: string | null;
  deliveredToOccurrenceId?: string | null;
};

/**
 * The three kinds, in one place, so the picker, the badges and the button
 * label cannot drift into describing them differently.
 *
 * `blurb` is written as what WILL HAPPEN, present tense, because it is read at
 * the moment of choosing. "Carries forward" told the operator what the flag was
 * called; it did not tell them where the instruction would end up.
 */
export const SCOPES: {
  value: InstructionScope; label: string; short: string; blurb: string;
  palette: string; icon: typeof Repeat;
}[] = [
  {
    value: "THIS_VISIT", label: "This visit only", short: "This visit",
    blurb: "Applies to this visit and nothing else.",
    palette: "gray", icon: CalendarCheck,
  },
  {
    value: "EVERY_VISIT", label: "Every visit", short: "Every visit",
    blurb: "Carries onto every future visit until you remove it.",
    palette: "blue", icon: Repeat,
  },
  {
    value: "NEXT_VISIT_ONLY", label: "Next visit only", short: "Next visit",
    blurb: "Waits here, then attaches to the next visit whenever it's created — even if that's after this job is paid.",
    palette: "purple", icon: CalendarArrowUp,
  },
];

const scopeOf = (v: InstructionScope) => SCOPES.find((s) => s.value === v) ?? SCOPES[0];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  currentInstructions?: Instruction[];
  onSaved?: (instructions: Instruction[]) => void;
  /** When false, carry-forward is hidden and all instructions default to non-repeating */
  isRepeating?: boolean;
};

export default function PinnedNoteDialog({
  open,
  onOpenChange,
  occurrenceId,
  currentInstructions,
  onSaved,
  isRepeating = true,
}: Props) {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [customText, setCustomText] = useState("");
  // What KIND the next added instruction will be. Chosen before adding, and
  // echoed on every add control, so nobody discovers the answer afterwards.
  const [newScope, setNewScope] = useState<InstructionScope>("EVERY_VISIT");
  const dlgErr = useDialogError();

  useEffect(() => {
    if (open) {
      setInstructions(currentInstructions ?? []);
      setCustomText("");
      setNewScope(isRepeating ? "EVERY_VISIT" : "THIS_VISIT");
    }
  }, [open, currentInstructions, isRepeating]);

  const usedPresets = new Set(instructions.filter((i) => i.isPreset).map((i) => i.text));

  async function addPreset(text: string) {
    dlgErr.clear();
    try {
      const created = await apiPost<Instruction>(`/api/occurrences/${occurrenceId}/instructions`, {
        text,
        isPreset: true,
        scope: isRepeating ? newScope : "THIS_VISIT",
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
      const created = await apiPost<Instruction>(`/api/occurrences/${occurrenceId}/instructions`, {
        text: customText.trim(),
        isPreset: false,
        scope: isRepeating ? newScope : "THIS_VISIT",
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
      await apiDelete(`/api/occurrences/${occurrenceId}/instructions/${id}`);
      setInstructions((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to remove.", err));
    }
  }

  /** Cycle an existing instruction through the three kinds. */
  async function cycleScope(id: string, current: InstructionScope) {
    dlgErr.clear();
    const order: InstructionScope[] = ["THIS_VISIT", "EVERY_VISIT", "NEXT_VISIT_ONLY"];
    const next = order[(order.indexOf(current) + 1) % order.length];
    try {
      await apiPatch(`/api/occurrences/${occurrenceId}/instructions/${id}`, { scope: next });
      setInstructions((prev) => prev.map((i) =>
        i.id === id ? { ...i, scope: next, ...(next === "NEXT_VISIT_ONLY" ? { deliveredAt: null } : {}) } : i));
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to update.", err));
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
                      <HStack
                        key={inst.id}
                        gap={2}
                        p={2}
                        // A delivered next-visit request is history, not a
                        // standing instruction — it reads as a record rather
                        // than something the crew still has to do.
                        bg={inst.deliveredAt ? "bg.subtle" : "yellow.50"}
                        borderWidth="1px"
                        borderColor={inst.deliveredAt ? "border" : "yellow.200"}
                        borderStyle={inst.scope === "NEXT_VISIT_ONLY" && !inst.deliveredAt ? "dashed" : "solid"}
                        borderRadius="md"
                        align="center"
                      >
                        <VStack align="start" gap={0.5} flex="1" minW={0}>
                          <Text fontSize="sm" color={inst.deliveredAt ? "fg.muted" : undefined}>{inst.text}</Text>
                          {/* NAME THE KIND on every row. The only affordance
                              before this was a repeat arrow whose two states
                              were a blue icon and a grey one. */}
                          <HStack gap={1}>
                            <Badge size="xs" variant="subtle" colorPalette={scopeOf(inst.scope).palette}>
                              {scopeOf(inst.scope).short}
                            </Badge>
                            {inst.deliveredAt && (
                              <Badge size="xs" variant="subtle" colorPalette="green">
                                sent to next visit
                              </Badge>
                            )}
                          </HStack>
                        </VStack>
                        {isRepeating && !inst.deliveredAt && (
                          <Button
                            size="xs"
                            variant="ghost"
                            px="1"
                            minW="0"
                            title={`${scopeOf(inst.scope).label} — click to change`}
                            onClick={() => void cycleScope(inst.id, inst.scope)}
                          >
                            {(() => { const Icon = scopeOf(inst.scope).icon; return <Icon size={12} />; })()}
                          </Button>
                        )}
                        {!inst.deliveredAt && (
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
                        )}
                      </HStack>
                    ))}
                  </VStack>
                )}

                {instructions.length === 0 && (
                  <Text fontSize="sm" color="fg.muted">No instructions yet. Add presets or custom instructions below.</Text>
                )}

                {/* WHAT KIND AM I ADDING — answered before anything is added,
                    not discovered afterwards. A checkbox reading "carry
                    forward to future occurrences" sat here and could express
                    only two of the three kinds. */}
                {isRepeating && (
                  <Box borderWidth="1px" borderColor="border" borderRadius="lg" p={2.5}>
                    <Text fontSize="xs" fontWeight="semibold" mb={1.5}>
                      What kind of instruction are you adding?
                    </Text>
                    <HStack gap={1} wrap="wrap">
                      {SCOPES.map((sc) => {
                        const Icon = sc.icon;
                        const active = newScope === sc.value;
                        return (
                          <Button
                            key={sc.value}
                            size="xs"
                            flex="1"
                            minW="96px"
                            variant={active ? "solid" : "outline"}
                            colorPalette={active ? sc.palette : "gray"}
                            onClick={() => setNewScope(sc.value)}
                          >
                            <Icon size={12} style={{ marginRight: 4 }} />
                            {sc.label}
                          </Button>
                        );
                      })}
                    </HStack>
                    {/* The consequence in plain words, switching with the
                        choice — the label alone does not say WHERE it lands. */}
                    <Text fontSize="xs" color="fg.muted" mt={1.5}>
                      {scopeOf(newScope).blurb}
                    </Text>
                  </Box>
                )}

                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>
                    Quick add{" "}
                    <Badge size="xs" variant="subtle" colorPalette={scopeOf(isRepeating ? newScope : "THIS_VISIT").palette}>
                      {scopeOf(isRepeating ? newScope : "THIS_VISIT").short}
                    </Badge>
                  </Text>
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
                  <Text fontSize="xs" fontWeight="medium" mb={1}>
                    Custom instruction{" "}
                    <Badge size="xs" variant="subtle" colorPalette={scopeOf(isRepeating ? newScope : "THIS_VISIT").palette}>
                      {scopeOf(isRepeating ? newScope : "THIS_VISIT").short}
                    </Badge>
                  </Text>
                  <HStack gap={2}>
                    <Input
                      size="sm"
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                      placeholder="e.g., Check irrigation timer"
                      onKeyDown={(e) => { if (e.key === "Enter") void addCustom(); }}
                    />
                    <Button
                      size="sm"
                      colorPalette={scopeOf(isRepeating ? newScope : "THIS_VISIT").palette}
                      disabled={!customText.trim()}
                      onClick={() => void addCustom()}
                    >
                      {newScope === "NEXT_VISIT_ONLY" && isRepeating ? "Add to next visit" : "Add"}
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
