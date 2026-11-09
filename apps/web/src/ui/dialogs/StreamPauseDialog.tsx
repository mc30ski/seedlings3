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

export type StreamPauseDialogMode =
  | "pause"
  | "update"
  | "resume"
  // THE SELECTION MODES, for the Repeating tab. They are here rather than in
  // a dialog of their own because the thing that must not drift is the REASON
  // field: it is mandatory, it pre-fills the reminder from its own horizon,
  // and a second copy of that logic is a second set of pauses that are hard
  // to find again. Holding thirty services is the same question as holding
  // one, asked once.
  | "pause-many"
  | "resume-many";

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
    }
  | {
      open: boolean;
      mode: "pause-many";
      /** How many streams are selected. Named in the title and the button, so
       *  the operator reads the count on the control they are about to press
       *  and not only in the row of checkboxes behind the dialog. */
      selectionCount: number;
      /** The rows themselves, rendered by the caller. A count alone is not
       *  "you know exactly what you are getting" — the list is. */
      summaryNode?: React.ReactNode;
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
      mode: "resume-many";
      selectionCount: number;
      summaryNode?: React.ReactNode;
      onCancel: () => void;
      /** `startAt` null means "each on its own cadence" — the server then
       *  computes one date per stream. A string is one shared date. */
      onConfirm: (input: { startAt: string | null }) => void | Promise<void>;
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
  /**
   * Selection resume only: restart each stream on its OWN rhythm, or all of
   * them on one date.
   *
   * CADENCE IS THE DEFAULT, and it is not a tidiness preference. Give thirty
   * held streams one shared date in April and thirty visits land in the same
   * week — a book-wide pile-up created by the control meant to undo a
   * book-wide hold. Stepping each one forward by its own interval puts them
   * back on the rhythm they already had.
   */
  const [resumeMode, setResumeMode] = useState<"cadence" | "date">("cadence");
  const [sharedStartAt, setSharedStartAt] = useState("");

  const many = props.mode === "pause-many" || props.mode === "resume-many";
  const count = many ? (props as { selectionCount: number }).selectionCount : 0;
  const plural =
    count === 1 ? "repeating job occurrence" : "repeating job occurrences";

  const title =
    props.mode === "pause"
      ? "Pause this repeating job occurrence?"
      : props.mode === "update"
        ? "Extend the pause"
        : props.mode === "resume"
          ? "Resume this repeating job occurrence?"
          : props.mode === "pause-many"
            ? `Pause ${count} ${plural}?`
            : `Resume ${count} ${plural}?`;

  const description =
    props.mode === "pause"
      ? `This holds just the ${props.occurrenceLabel} repeating on this service. The service's other repeating job occurrences (mowing, say, while you hold hedging) keep running. The customer and the service stay Active.`
      : props.mode === "update"
        ? "Update the reason and/or reminder date without changing anything else."
        : props.mode === "resume"
          ? `Choose a fresh date for the ${props.occurrenceLabel} to restart. Its repeating schedule will resume from that visit forward.`
          : props.mode === "pause-many"
            // COUNT-AWARE, because a selection of one is a normal thing to
            // do from a filtered table and "each of these 1" is the kind of
            // sentence that makes an operator doubt the screen.
            ? count === 1
              ? "The reason, note and check-back date below are recorded against it exactly as if you had paused it from its own card. Every other job occurrence stays on its schedule. Customers and services stay Active."
              : `One reason, one note and one check-back date are recorded against all ${count}, exactly as if you had paused them one at a time. Every other job occurrence stays on its schedule. Customers and services stay Active.`
            : count === 1
              ? "It goes back on the schedule. Nothing else about it changes."
              : `All ${count} go back on the schedule. Nothing else about them changes.`;

  // A reason is REQUIRED to pause or to edit a pause. The free text is not —
  // it is the detail, and demanding prose is how you get "n/a" typed into a
  // field you then cannot aggregate.
  const canConfirm =
    props.mode === "resume"
      ? !!newStartAt
      : props.mode === "resume-many"
        ? resumeMode === "cadence" || !!sharedStartAt
        : !!reasonCode;
  const asksForReason =
    props.mode === "pause" || props.mode === "update" || props.mode === "pause-many";

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

                {/* WHAT IS ABOUT TO BE TOUCHED, LISTED. The whole reason a
                    selection is safe where the removed client-level cascade
                    was not is that the operator can see the rows; printing a
                    count and hiding the names would give that away. */}
                {many && props.summaryNode}

                {asksForReason && (
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
                          {/* Named for the test to find: the trigger is an
                              ark-ui combobox, not a button carrying the
                              placeholder as its accessible name, so there is
                              nothing stable to select it by otherwise. */}
                          <Select.Trigger w="full" px="2" data-testid="stream-pause-reason">
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

                {props.mode === "resume-many" && (
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>
                      When do they restart?
                    </Text>
                    {/* A segmented pair, not a dropdown: there are two
                        answers, one is strongly preferred, and both need a
                        sentence of their own to choose between. */}
                    <VStack align="stretch" gap={2}>
                      <Button
                        size="sm"
                        variant={resumeMode === "cadence" ? "subtle" : "outline"}
                        colorPalette={resumeMode === "cadence" ? "green" : undefined}
                        justifyContent="flex-start"
                        onClick={() => setResumeMode("cadence")}
                        data-testid="resume-many-cadence"
                        aria-pressed={resumeMode === "cadence"}
                      >
                        Each on its own cadence
                      </Button>
                      <Button
                        size="sm"
                        variant={resumeMode === "date" ? "subtle" : "outline"}
                        colorPalette={resumeMode === "date" ? "green" : undefined}
                        justifyContent="flex-start"
                        onClick={() => {
                          setResumeMode("date");
                          if (!sharedStartAt) setSharedStartAt(bizAddDays(bizToday(), 7));
                        }}
                        data-testid="resume-many-date"
                        aria-pressed={resumeMode === "date"}
                      >
                        All on one date
                      </Button>
                      {resumeMode === "cadence" ? (
                        <Text fontSize="2xs" color="fg.muted">
                          Each one steps forward from its own last visit by its own interval
                          until it lands today or later, so they spread back out the way they
                          were before. This is almost always what you want.
                        </Text>
                      ) : (
                        <>
                          <Input
                            type="date"
                            value={sharedStartAt}
                            onChange={(e) => setSharedStartAt(e.target.value)}
                          />
                          <Text fontSize="2xs" color="fg.muted">
                            Every selected service restarts on this date. With {count}{" "}
                            selected that is {count} visits in one day — fine for a handful,
                            rarely what you want for a whole season.
                          </Text>
                        </>
                      )}
                    </VStack>
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
                    props.mode === "resume" || props.mode === "resume-many"
                      ? "green"
                      : "purple"
                  }
                  onClick={async () => {
                    if (props.mode === "resume") {
                      await props.onConfirm({ newStartAt });
                    } else if (props.mode === "resume-many") {
                      await props.onConfirm({
                        startAt: resumeMode === "date" ? sharedStartAt || null : null,
                      });
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
                  data-testid={`stream-pause-confirm-${props.mode}`}
                >
                  {props.mode === "pause"
                    ? "Pause repeating"
                    : props.mode === "update"
                      ? "Save changes"
                      : props.mode === "resume"
                        ? "Resume repeating"
                        : props.mode === "pause-many"
                          ? `Pause ${count}`
                          : `Resume ${count}`}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
