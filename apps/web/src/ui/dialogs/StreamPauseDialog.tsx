"use client";

// Dialog for the three occurrence-level stream operations: pause,
// update-pause (extend), and resume. Same component handles all three
// so the field layout stays consistent (reason + reminder date live in
// one place regardless of which action the operator picked).
//
// The parent decides which mode to open and passes callbacks + current
// values (for update) or a default new-start-date (for resume).

import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  Select,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { usePauseReasons } from "@/src/lib/pauseReasons";
import { bizToday, bizAddDays } from "@/src/lib/dates";

export type StreamPauseDialogMode = "pause" | "update" | "resume";

type Props =
  | {
      open: boolean;
      mode: "pause";
      /** Name/label to show in the title (e.g. "hedge visit on 2026-08-10"). */
      occurrenceLabel: string;
      onCancel: () => void;
      onConfirm: (input: {
        reasonCode: string;
        reason: string | null;
        reminderAt: string | null; // YYYY-MM-DD or null
      }) => void | Promise<void>;
      busy?: boolean;
    }
  | {
      open: boolean;
      mode: "update";
      occurrenceLabel: string;
      currentReason: string | null;
      currentReasonCode: string | null;
      currentReminderAt: string | null; // YYYY-MM-DD or null
      onCancel: () => void;
      onConfirm: (input: {
        reasonCode: string;
        reason: string | null;
        reminderAt: string | null;
      }) => void | Promise<void>;
      busy?: boolean;
    }
  | {
      open: boolean;
      mode: "resume";
      occurrenceLabel: string;
      defaultNewStartAt: string; // YYYY-MM-DD, prefilled by parent
      onCancel: () => void;
      onConfirm: (input: { newStartAt: string }) => void | Promise<void>;
      busy?: boolean;
    };

export default function StreamPauseDialog(props: Props) {
  const initialReason =
    props.mode === "update" ? props.currentReason ?? "" : "";
  const initialReminder =
    props.mode === "update" ? props.currentReminderAt ?? "" : "";
  const initialStart =
    props.mode === "resume" ? props.defaultNewStartAt : "";

  const reasons = usePauseReasons();
  const [reasonCode, setReasonCode] = useState(
    props.mode === "update" ? props.currentReasonCode ?? "" : "",
  );
  const [reason, setReason] = useState(initialReason);
  const [reminderAt, setReminderAt] = useState(initialReminder);
  /** The date "Set a date" starts from: this reason's own horizon, falling
   *  back to a fortnight. Mounting the picker on today would make the
   *  commonest next action "now change it". */
  function suggestedReminder(): string {
    const days = reasons.find((r) => r.code === reasonCode)?.defaultReminderDays;
    return bizAddDays(bizToday(), typeof days === "number" && days > 0 ? days : 14);
  }
  const [newStartAt, setNewStartAt] = useState(initialStart);

  const title =
    props.mode === "pause"
      ? "Pause this repeating service?"
      : props.mode === "update"
        ? "Extend the pause"
        : "Resume this repeating service?";

  const description =
    props.mode === "pause"
      ? `This pauses just the ${props.occurrenceLabel} repeating on this Job. Other repeating services on the same Job (e.g. mowing while you pause hedging) keep running. The Client and Job stay Active.`
      : props.mode === "update"
        ? "Update the reason and/or reminder date without changing anything else."
        : `Choose a fresh date for the ${props.occurrenceLabel} to restart. Its repeating schedule will resume from that visit forward.`;

  // A reason is REQUIRED to pause or to edit a pause. The free text is not —
  // it is the detail, and demanding prose is how you get "n/a" typed into a
  // field you then cannot aggregate.
  const canConfirm =
    props.mode === "resume" ? !!newStartAt : !!reasonCode;

  /** Picking a reason pre-fills the reminder from its own horizon.
   *
   *  This is what stops a pause becoming a disappearance. Both surfaces that
   *  resurface a paused service only query reminders that are already DUE, so
   *  a pause with no reminder is invisible to them forever — which is exactly
   *  what happened to the one production pause that predates this dropdown.
   *  Only fills an EMPTY field; a date the operator typed is never overwritten. */
  function onPickReason(code: string) {
    setReasonCode(code);
    if (reminderAt) return;
    const days = reasons.find((r) => r.code === code)?.defaultReminderDays;
    if (typeof days === "number" && days > 0) {
      setReminderAt(bizAddDays(bizToday(), days));
    }
  }

  const reasonCollection = createListCollection({
    items: reasons.map((r) => ({ label: r.label, value: r.code })),
  });
  const pickedHint = reasons.find((r) => r.code === reasonCode)?.hint ?? null;

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(e) => { if (!e.open && !props.busy) props.onCancel(); }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full">
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">{description}</Text>

                {(props.mode === "pause" || props.mode === "update") && (
                  <>
                    {/* THE CODED REASON — required, and the only part of this
                        dialog you can later filter or count on. Picking one
                        also fills the reminder below from that reason's own
                        horizon, so "season over" lands in spring without
                        anyone doing date arithmetic. */}
                    <Box>
                      <Text fontSize="xs" fontWeight="medium" mb={1}>
                        Reason <Text as="span" color="red.fg">*</Text>
                      </Text>
                      <Select.Root
                        collection={reasonCollection}
                        value={reasonCode ? [reasonCode] : []}
                        onValueChange={(e) => onPickReason(e.value?.[0] ?? "")}
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger w="full" px="2">
                            <Select.ValueText placeholder="Why is this pausing?" />
                            <Select.Indicator />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content maxH="260px" overflowY="auto">
                            {reasonCollection.items.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                      {pickedHint && (
                        <Text fontSize="2xs" color="fg.muted" mt={1}>{pickedHint}</Text>
                      )}
                    </Box>
                    <Box>
                      <Text fontSize="xs" fontWeight="medium" mb={1}>
                        Note (optional)
                      </Text>
                      <Textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Anything the reason above does not capture — who asked, what changed, what to check before resuming"
                        rows={3}
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" fontWeight="medium" mb={1}>
                        Reminder date (optional)
                      </Text>
                      {/* NO EMPTY DATE INPUT, EVER.
                          A cleared <input type="date"> is rendered by the
                          browser, not by us, and browsers disagree: one paints
                          "mm/dd/yyyy", another paints TODAY. The second is a
                          lie the operator cannot argue with — the dialog said
                          there was no reminder in its helper text while the
                          field showed a date, and saving would then have been
                          a guess about which one the app believed. Forcing a
                          repaint did not help, because the repaint itself was
                          what produced today. So when there is no reminder
                          there is no date control: the empty state is our copy
                          and our button, which every browser renders the same. */}
                      {reminderAt ? (
                        <>
                          <HStack gap={2}>
                            <Input
                              type="date"
                              value={reminderAt}
                              onChange={(e) => setReminderAt(e.target.value)}
                              flex="1"
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setReminderAt("")}
                              title="Remove the reminder — the visit stays paused"
                            >
                              Clear
                            </Button>
                          </HStack>
                          <Text fontSize="2xs" color="fg.muted" mt={1}>
                            Shows up as an alert on the Tasks page when the date arrives.
                          </Text>
                        </>
                      ) : (
                        <>
                          <HStack
                            gap={2}
                            borderWidth="1px"
                            borderColor="border.emphasized"
                            borderRadius="md"
                            px={3}
                            py={2}
                          >
                            <Text fontSize="sm" color="fg.muted" flex="1">
                              No reminder set
                            </Text>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setReminderAt(suggestedReminder())}
                            >
                              Set a date
                            </Button>
                          </HStack>
                          <Text fontSize="2xs" color="fg.muted" mt={1}>
                            This stays paused and searchable, but nothing will bring it back to
                            your attention — leave it empty only when there is no realistic date
                            to check back on.
                          </Text>
                        </>
                      )}
                    </Box>
                  </>
                )}

                {props.mode === "resume" && (
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>
                      New start date
                    </Text>
                    <Input
                      type="date"
                      value={newStartAt}
                      onChange={(e) => setNewStartAt(e.target.value)}
                    />
                    <Text fontSize="2xs" color="fg.muted" mt={1}>
                      Default is roughly one cadence from today, but you can pick any date.
                    </Text>
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2}>
                <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
                  Cancel
                </Button>
                <Button
                  colorPalette={
                    props.mode === "resume" ? "green" : "purple"
                  }
                  onClick={async () => {
                    if (props.mode === "resume") {
                      await props.onConfirm({ newStartAt });
                    } else {
                      await props.onConfirm({
                        reasonCode,
                        reason: reason.trim() || null,
                        reminderAt: reminderAt || null,
                      });
                    }
                  }}
                  loading={props.busy}
                  disabled={!canConfirm}
                >
                  {props.mode === "pause"
                    ? "Pause repeating"
                    : props.mode === "update"
                      ? "Save changes"
                      : "Resume repeating"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
