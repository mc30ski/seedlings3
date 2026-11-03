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
import { CalendarArrowUp, CalendarCheck, Clock, Repeat, X } from "lucide-react";
import { apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";

/**
 * TIMING PRESETS, separate from the twelve below.
 *
 * None of the on-site presets are timing-shaped — "Skip backyard" is a
 * thing you do when you arrive. These are the constraints that come up
 * often enough to be one tap, and they are all well inside the 50
 * characters the band allows.
 */
const TIMING_PRESETS = [
  "Before 10am",
  "Before noon",
  "After 9am",
  "Mornings only",
  "Afternoons only",
];

/** Matches TIMING_TEXT_MAX on the server; the band has to fit a phone row. */
const TIMING_MAX = 50;

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
  /** NOTE is read on site; TIMING is read before setting off and is banded
   *  across the top of the job card. Absent on rows from an older client. */
  kind?: "NOTE" | "TIMING";
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
  /** THE CARD'S OWN PALETTE, handed down by whoever opened this dialog.
   *  The timing rows below are the same band the card wears, so they must
   *  be the same colour as it — a fixed hue here means the editor and the
   *  thing it edits disagree on screen. `gray` is the fallback, for a
   *  caller with no card colour to pass (ServicesTab opens this from a job
   *  detail list, where no coloured card is in view). */
  palette?: string;
};

export default function PinnedNoteDialog({
  open,
  onOpenChange,
  occurrenceId,
  currentInstructions,
  onSaved,
  isRepeating = true,
  palette = "gray",
}: Props) {
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [customText, setCustomText] = useState("");
  // What KIND the next added instruction will be. Chosen before adding, and
  // echoed on every add control, so nobody discovers the answer afterwards.
  const [newScope, setNewScope] = useState<InstructionScope>("EVERY_VISIT");
  /** The timing box, kept separate from `customText` so typing one does not
   *  half-fill the other. */
  const [timingText, setTimingText] = useState("");
  const [timingScope, setTimingScope] = useState<InstructionScope>("EVERY_VISIT");
  /** Set when the server refuses because this scope already has a timing.
   *  Holds what WOULD be lost, so the question can name it. */
  const [replace, setReplace] = useState<{ text: string; existing: string } | null>(null);
  const dlgErr = useDialogError();

  useEffect(() => {
    if (open) {
      setInstructions(currentInstructions ?? []);
      setCustomText("");
      setTimingText("");
      setReplace(null);
      setNewScope(isRepeating ? "EVERY_VISIT" : "THIS_VISIT");
      setTimingScope(isRepeating ? "EVERY_VISIT" : "THIS_VISIT");
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

  /**
   * Add a timing constraint.
   *
   * ASKS BEFORE REPLACING. A visit carries one standing timing and one for
   * this visit, so a second of the same scope is a replacement. The server
   * refuses it with the row that is in the way rather than overwriting,
   * and `force` is only sent once the operator has answered the question
   * that refusal produced.
   */
  async function addTiming(text: string, force = false) {
    dlgErr.clear();
    const clean = text.trim();
    if (!clean) return;
    try {
      const created = await apiPost<Instruction>(`/api/occurrences/${occurrenceId}/instructions`, {
        text: clean,
        isPreset: TIMING_PRESETS.includes(clean),
        kind: "TIMING",
        scope: isRepeating ? timingScope : "THIS_VISIT",
        ...(force ? { replaceExisting: true } : {}),
      });
      setInstructions((prev) => [
        // The replaced row is gone server-side; drop it here too rather
        // than reloading, so the preview and the list agree immediately.
        ...prev.filter((i) => !(i.kind === "TIMING" && i.scope === created.scope)),
        created,
      ]);
      setTimingText("");
      setReplace(null);
    } catch (err: any) {
      const body = String(err?.message ?? "");
      const m = body.match(/TIMING_SCOPE_TAKEN/);
      if (m) {
        let existing = "the one already set";
        try { existing = JSON.parse(body.slice(body.indexOf("{"))).existing?.text ?? existing; } catch {}
        setReplace({ text: clean, existing });
        return;
      }
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
                {/* ── TIMING, ABOVE THE INSTRUCTIONS ──────────────────────
                    The order mirrors the card: timing bands the top,
                    instructions sit in the body. It is the same split —
                    what you need before setting off, then what you need on
                    site. */}
                <Box>
                  <Text fontSize="2xs" textTransform="uppercase" letterSpacing="wide" color="fg.muted">
                    Timing
                  </Text>
                  <Text fontSize="2xs" color="fg.muted" mb={1.5}>
                    When the crew can and cannot come. Shown on every card, before they set off.
                  </Text>

                  {/* What is already set, as the band itself — so the row
                      in the dialog and the row on the card are the same
                      object rather than two descriptions of one. */}
                  {instructions.filter((i) => i.kind === "TIMING").length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {instructions.filter((i) => i.kind === "TIMING").map((t) => (
                        <HStack key={t.id} gap={1.5} px={2} py={1} rounded="sm"
                                bg={`${palette}.emphasized`} color={`${palette}.fg`}
                                borderBottomWidth="2px" borderColor={`${palette}.solid`}>
                          <Clock size={11} />
                          <Text fontSize="2xs" fontWeight="bold" flex="1" minW={0}>{t.text}</Text>
                          <Text fontSize="2xs" opacity={0.85} whiteSpace="nowrap">
                            {scopeOf(t.scope).short}
                          </Text>
                          <Box as="button" aria-label="Remove timing" onClick={() => void removeInstruction(t.id)}>
                            <X size={11} />
                          </Box>
                        </HStack>
                      ))}
                    </VStack>
                  )}

                  {/* ASKS BEFORE REPLACING. Names what is there, what is
                      replacing it, and why there can only be one. */}
                  {replace && (
                    <Box borderWidth="1px" borderColor="orange.emphasized" bg="orange.subtle" rounded="md" p={2} mb={2}>
                      <Text fontSize="2xs" fontWeight="bold" color="orange.fg" mb={1}>
                        Replace the {scopeOf(timingScope).short.toLowerCase()} timing?
                      </Text>
                      <Text fontSize="2xs" color="fg.muted" mb={2}>
                        This visit already has <b>{replace.existing}</b>. A job carries one standing
                        timing and one for this visit, so adding <b>{replace.text}</b> removes it.
                      </Text>
                      <HStack gap={2} justify="flex-end">
                        <Button size="xs" variant="ghost" onClick={() => setReplace(null)}>Cancel</Button>
                        <Button size="xs" colorPalette="orange" onClick={() => void addTiming(replace.text, true)}>
                          Replace
                        </Button>
                      </HStack>
                    </Box>
                  )}

                  <HStack gap={1} wrap="wrap" mb={2}>
                    {TIMING_PRESETS.map((t) => (
                      <Button key={t} size="2xs" variant="outline" onClick={() => void addTiming(t)}>
                        {t}
                      </Button>
                    ))}
                  </HStack>
                  <HStack gap={2}>
                    <Input
                      size="sm"
                      flex="1"
                      maxLength={TIMING_MAX}
                      value={timingText}
                      placeholder="or type one — keep it short"
                      onChange={(e) => setTimingText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void addTiming(timingText); }}
                    />
                    <Button size="sm" variant="outline" disabled={!timingText.trim()} onClick={() => void addTiming(timingText)}>
                      Add
                    </Button>
                  </HStack>
                  {/* THE COUNTER BELONGS TO THE FIELD, AND ONLY WHILE IT IS
                      IN USE. It shipped as a bare "0 / 50" on the row BELOW,
                      sharing that row with the scope chips — so it sat beside
                      the chips, counted nothing anybody could name, and was
                      read as a count of something else entirely. It now sits
                      directly under the input it limits, says what it is
                      counting, and is absent until there is something to
                      count. */}
                  {timingText.length > 0 && (
                    <Text fontSize="2xs" mt={0.5} textAlign="right"
                          color={timingText.length >= TIMING_MAX ? "orange.fg" : "fg.muted"}>
                      {timingText.length >= TIMING_MAX
                        ? `${TIMING_MAX}-character limit reached`
                        : `${TIMING_MAX - timingText.length} characters left`}
                    </Text>
                  )}
                  {isRepeating && (
                    <HStack gap={1} mt={1}>
                      {(["THIS_VISIT", "EVERY_VISIT"] as InstructionScope[]).map((sc) => (
                        <Button key={sc} size="2xs" variant={timingScope === sc ? "solid" : "outline"}
                                onClick={() => setTimingScope(sc)}>
                          {scopeOf(sc).short}
                        </Button>
                      ))}
                    </HStack>
                  )}
                </Box>

                {instructions.filter((i) => i.kind !== "TIMING").length > 0 && (
                  <VStack align="stretch" gap={1}>
                    {instructions.filter((i) => i.kind !== "TIMING").map((inst) => (
                      <HStack
                        key={inst.id}
                        gap={2}
                        p={2}
                        // A delivered next-visit request is history, not a
                        // standing instruction — it reads as a record rather
                        // than something the crew still has to do.
                        bg={inst.deliveredAt ? "bg.subtle" : "yellow.faint"}
                        borderWidth="1px"
                        borderColor={inst.deliveredAt ? "border" : "yellow.emphasized"}
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
                        _hover={{ bg: "yellow.subtle" }}
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
