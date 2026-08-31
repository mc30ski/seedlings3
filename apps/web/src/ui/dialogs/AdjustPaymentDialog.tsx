"use client";

import { useEffect, useMemo, useState } from "react";
import { bizToday, type EtDateKey } from "@/src/lib/dates";
import DateInput from "@/src/ui/components/DateInput";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { usePaymentMethodLabels } from "@/src/lib/usePaymentMethodLabels";

/**
 * THE approve dialog for a pending payment. Opened by the Approve button.
 * Correct anything that affects the final accounting, then approve:
 *
 *   1. Amount — what actually arrived in your account
 *   2. Method — what the client actually paid through (e.g. they reported
 *      OTHER but actually used Venmo)
 *   3. Fee    — the processor fee. The estimate auto-recomputes whenever
 *      amount or method changes (formula = grossCharged × feePercent + feeFixed);
 *      the admin can override to match the exact figure that hit the
 *      processor statement.
 *   4. Tip    — appears the moment the amount exceeds the invoice.
 *
 * MERGED 2026-09-01. There used to be TWO buttons: "Approve" (fee + date
 * only) and "Edit" (this dialog). That split made tips undiscoverable — the
 * button labelled Approve couldn't change the amount, and the one that could
 * was called Edit, so nothing on the approve screen suggested a tip was even
 * possible. Since this dialog was already a strict superset, the fast path
 * costs nothing: the amount is pre-filled with what was reported, so
 * "approve as reported" is still a single click.
 */

type AdjustRow = {
  id: string;
  amountPaid: number;
  method: string;
  processorFeeAmount: number | null;
  /** Invoice total (price + add-ons). Raising the collected amount above
   *  this is what makes the payment an overpayment — and an overpayment is
   *  the only thing that can be designated a tip. */
  invoiceTotal: number;
  /** Non-observer assignees, for the tip split editor. */
  assignees: Array<{ userId: string; displayName: string; isOwner: boolean }>;
  /** Per-worker job percentages, if set. Seeds the tip defaults. */
  completionSplits: Array<{ userId: string; percent: number }> | null;
  /** Existing note on the payment (whatever the worker wrote when they
   *  first recorded it, if anything). Seeds the note textarea so the
   *  admin sees what's there before adding to it. */
  note?: string | null;
};

type Props = {
  row: AdjustRow | null;
  /** Whether approving will auto-schedule the next occurrence (for the copy). */
  willScheduleNext: boolean;
  /** Called on Approve with the final values. Each field is only included
   *  when it differs from the row's current value, mirroring how the
   *  backend `/admin/payments/:id/approve` overrides work — only changes
   *  are sent. */
  onConfirm: (changes: {
    amountOverride?: number;
    methodOverride?: string;
    feeOverride?: number;
    noteOverride?: string | null;
    /** YYYY-MM-DD ET. Only set when the admin back-dated the
     *  "payment received on" field from today. Backend anchors to
     *  ET-noon; absent = fall through to server's `now()`. */
    paidAtOverride?: string;
    /** Tip designation. Present only when the admin raised the amount above
     *  the invoice AND marked the difference a tip. */
    tip?: {
      amount: number;
      businessPercent: number;
      workerPercents: Array<{ userId: string; percent: number }>;
    } | null;
  }) => void;
  onCancel: () => void;
};

const PENNY = 0.005;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function AdjustPaymentDialog({ row, willScheduleNext, onConfirm, onCancel }: Props) {
  const open = !!row;
  const { methods } = usePaymentMethodLabels();

  const [amountStr, setAmountStr] = useState("");
  const [methodKey, setMethodKey] = useState("");
  const [feeStr, setFeeStr] = useState("");
  /** Free-text note. Mirrors the "Reconcile Paid" flow on Awaiting
   *  Payment where the admin can attach a memo at the moment of
   *  approval (e.g. "client paid via check delivered to my house on
   *  7/12"). Seeded from the payment's existing note so the admin
   *  either sees / edits the worker's original text OR starts from
   *  blank if there wasn't one. */
  const [noteStr, setNoteStr] = useState("");
  const [paidAt, setPaidAt] = useState<EtDateKey>(bizToday());
  /** True once the admin manually edits the fee — pins the value so a
   *  later amount/method change doesn't blow away their override. Reset
   *  on dialog open. */
  const [feeManuallyEdited, setFeeManuallyEdited] = useState(false);

  // Seed state from the row on open. Method picker defaults to the
  // originally-reported method; amount + fee come from the same row.
  //
  // Keyed on row?.id, NOT the row object. A caller that builds the prop
  // inline (`row={{ ...somethingFor(x) }}`) hands us a fresh object every
  // render, so an identity-keyed effect re-fires on every keystroke and
  // resets the field the operator is typing into. That shipped once: you
  // could type an amount, watch the tip editor appear, and see the value
  // snap back to the reported figure a frame later.
  const rowId = row?.id ?? null;
  useEffect(() => {
    if (!row) return;
    setAmountStr(row.amountPaid.toFixed(2));
    setMethodKey(row.method);
    setFeeStr((row.processorFeeAmount ?? 0).toFixed(2));
    setNoteStr(row.note ?? "");
    setFeeManuallyEdited(false);
    setPaidAt(bizToday());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);

  const amountNum = Number.parseFloat(amountStr);
  const amountValid = Number.isFinite(amountNum) && amountNum >= 0;

  // ── Tip designation ────────────────────────────────────────────────
  // Recomputed live from the amount field, so raising "Actual amount
  // collected" above the invoice reveals the editor as you type. This is
  // the primary path: the worker tells you a tip was left, you enter the
  // real amount here, and designate the difference.
  const overpayment = row && amountValid ? round2(amountNum - row.invoiceTotal) : 0;
  const canTip = overpayment > 0;
  const [isTip, setIsTip] = useState(false);
  const [bizPct, setBizPct] = useState("0");
  const [workerPct, setWorkerPct] = useState<Record<string, string>>({});
  // Same identity trap as the seeding effect above — key on the id.
  useEffect(() => {
    if (!row) return;
    setIsTip(false);
    setBizPct("0");
    const cs = new Map((row.completionSplits ?? []).map((c) => [c.userId, c.percent]));
    const n = row.assignees.length;
    const next: Record<string, string> = {};
    for (const a of row.assignees) {
      const pct = cs.get(a.userId) ?? (n > 0 ? 100 / n : 0);
      next[a.userId] = String(Math.round(pct * 100) / 100);
    }
    setWorkerPct(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);
  const tipPctSum = round2(
    (Number.parseFloat(bizPct) || 0) +
      (row?.assignees ?? []).reduce((s, a) => s + (Number.parseFloat(workerPct[a.userId]) || 0), 0),
  );
  const tipPctValid = Math.abs(tipPctSum - 100) <= 0.01;
  const ownerPct = (row?.assignees ?? [])
    .filter((a) => a.isOwner)
    .reduce((s, a) => s + (Number.parseFloat(workerPct[a.userId]) || 0), 0);
  const effectiveBizPct = round2((Number.parseFloat(bizPct) || 0) + ownerPct);
  const tipDollars = (pct: number) => round2((overpayment * pct) / 100);

  // The selected method's fee config drives both the computed-fee preview
  // and the "show fee section?" decision. A method with no fee (Cash,
  // Zelle) hides the fee box entirely.
  const selectedMethod = useMemo(
    () => methods.find((m) => m.key === methodKey) ?? null,
    [methods, methodKey],
  );
  const hasFee = !!selectedMethod && (selectedMethod.feePercent > 0 || selectedMethod.feeFixed > 0);

  // Recomputed fee estimate. Matches the backend formula in
  // services/payments.ts > computeProcessorFee:
  //   processorFee = round(gross × feePercent / 100 + feeFixed, 2)
  const computedFee = useMemo(() => {
    if (!hasFee || !selectedMethod || !amountValid) return 0;
    return round2(amountNum * selectedMethod.feePercent / 100 + selectedMethod.feeFixed);
  }, [hasFee, selectedMethod, amountValid, amountNum]);

  // When amount or method changes (and the admin hasn't manually edited
  // the fee yet), snap fee back to the recomputed estimate. Once they
  // override, leave it alone — they may be matching an actual processor
  // statement value that won't naturally line up with the formula.
  useEffect(() => {
    if (!hasFee) {
      setFeeStr("0.00");
      return;
    }
    if (!feeManuallyEdited) {
      setFeeStr(computedFee.toFixed(2));
    }
  }, [computedFee, hasFee, feeManuallyEdited]);

  const feeNum = Number.parseFloat(feeStr);
  const feeValid = !hasFee || (Number.isFinite(feeNum) && feeNum >= 0 && (!amountValid || feeNum <= amountNum));
  const net = amountValid && feeValid ? round2(amountNum - (hasFee ? feeNum : 0)) : null;

  // The Select collection is stable across renders so Chakra's internal
  // state doesn't get reset when this component re-renders (which it does
  // on every keystroke via amountStr).
  const methodCollection = useMemo(
    () =>
      createListCollection({
        items: methods
          .filter((m) => m.active || m.key === row?.method)
          .map((m) => ({ label: m.label, value: m.key })),
      }),
    [methods, row?.method],
  );

  // Block confirm while a designated tip's percentages don't total 100 —
  // the money would otherwise land somewhere unintended.
  const canConfirm = amountValid && !!methodKey && feeValid && (!isTip || tipPctValid);

  function confirm() {
    if (!row || !canConfirm) return;
    const changes: {
      amountOverride?: number;
      methodOverride?: string;
      feeOverride?: number;
      noteOverride?: string | null;
      paidAtOverride?: string;
      tip?: {
        amount: number;
        businessPercent: number;
        workerPercents: Array<{ userId: string; percent: number }>;
      } | null;
    } = {};
    const finalAmount = round2(amountNum);
    if (isTip && canTip && tipPctValid && row) {
      changes.tip = {
        amount: overpayment,
        businessPercent: Number.parseFloat(bizPct) || 0,
        workerPercents: row.assignees.map((a) => ({
          userId: a.userId,
          percent: Number.parseFloat(workerPct[a.userId]) || 0,
        })),
      };
    }
    if (finalAmount !== round2(row.amountPaid)) changes.amountOverride = finalAmount;
    if (methodKey !== row.method) changes.methodOverride = methodKey;
    // Fee override only when the user's value differs from the auto-
    // computed estimate by more than half a cent. Matches the
    // the same half-cent policy the backend expects, so semantics line up.
    if (hasFee && Math.abs(feeNum - computedFee) >= PENNY) {
      changes.feeOverride = round2(feeNum);
    }
    // Note override — only when the trimmed value differs from what was
    // originally on the row (empty vs. empty is a no-op). Clearing an
    // existing note sends null explicitly so the backend can distinguish
    // "not editing" from "erase this."
    const originalNote = (row.note ?? "").trim();
    const nextNote = noteStr.trim();
    if (nextNote !== originalNote) {
      changes.noteOverride = nextNote.length > 0 ? nextNote : null;
    }
    if (paidAt !== bizToday()) {
      changes.paidAtOverride = paidAt;
    }
    onConfirm(changes);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onCancel(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>Approve this payment?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">
                  Reported as{" "}
                  <Text as="span" fontWeight="medium" color="fg.default">
                    ${row?.amountPaid.toFixed(2) ?? "0.00"} via {row?.method ?? "—"}
                  </Text>
                  . Approving closes the job
                  {willScheduleNext ? " and schedules the next occurrence" : ""}.
                  Correct anything below first — if the client paid MORE than the
                  invoice, raise the amount and you can split the difference as a
                  tip. The fee recomputes automatically.
                </Text>

                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Actual amount collected
                  </Text>
                  <CurrencyInput
                    value={amountStr}
                    onChange={setAmountStr}
                    size="sm"
                    placeholder="0.00"
                  />
                </Box>

                {/* Tip designation. Appears the moment the amount typed above
                    exceeds the invoice — this is the primary path for
                    recording a tip: the worker tells you the client left one,
                    you enter the real amount, and split the difference. */}
                {canTip && (
                  <Box borderWidth="1px" borderColor={isTip ? "green.300" : "gray.200"} bg={isTip ? "green.50" : undefined} borderRadius="md" p={3}>
                    <VStack align="stretch" gap={2}>
                      <HStack justify="space-between" align="center">
                        <VStack align="start" gap={0}>
                          <Text fontSize="sm" fontWeight="semibold">
                            ${overpayment.toFixed(2)} over the invoice
                          </Text>
                          <Text fontSize="xs" color="fg.muted">
                            Invoice ${row?.invoiceTotal.toFixed(2)} · collecting ${amountNum.toFixed(2)}
                          </Text>
                        </VStack>
                        <Button
                          size="xs"
                          variant={isTip ? "solid" : "outline"}
                          colorPalette={isTip ? "green" : "gray"}
                          onClick={() => setIsTip((v) => !v)}
                        >
                          {isTip ? "It's a tip ✓" : "It's a tip"}
                        </Button>
                      </HStack>

                      {!isTip && (
                        <Text fontSize="xs" color="fg.muted">
                          Left as-is, the business keeps the ${overpayment.toFixed(2)} as
                          income. Mark it a tip to share it with the crew.
                        </Text>
                      )}

                      {isTip && (
                        <VStack align="stretch" gap={2}>
                          <Text fontSize="xs" color="fg.muted">
                            Split the ${overpayment.toFixed(2)} tip. Defaults to each worker's
                            share of the job. Tips skip commission and margin.
                          </Text>
                          <HStack justify="space-between" align="center">
                            <Text fontSize="sm">Business</Text>
                            <HStack gap={2}>
                              <Input size="xs" w="64px" textAlign="right" inputMode="decimal"
                                value={bizPct} onChange={(e) => setBizPct(e.target.value)} />
                              <Text fontSize="xs" color="fg.muted" w="14px">%</Text>
                              <Text fontSize="sm" fontWeight="medium" w="64px" textAlign="right">
                                ${tipDollars(Number.parseFloat(bizPct) || 0).toFixed(2)}
                              </Text>
                            </HStack>
                          </HStack>
                          {(row?.assignees ?? []).map((a) => (
                            <HStack key={a.userId} justify="space-between" align="center">
                              <Text fontSize="sm">
                                {a.displayName}
                                {a.isOwner && (
                                  <Text as="span" fontSize="2xs" color="purple.700" ml={1} fontWeight="semibold">
                                    LLC Owner
                                  </Text>
                                )}
                              </Text>
                              <HStack gap={2}>
                                <Input size="xs" w="64px" textAlign="right" inputMode="decimal"
                                  value={workerPct[a.userId] ?? "0"}
                                  onChange={(e) => setWorkerPct((prev) => ({ ...prev, [a.userId]: e.target.value }))} />
                                <Text fontSize="xs" color="fg.muted" w="14px">%</Text>
                                <Text fontSize="sm" fontWeight="medium" w="64px" textAlign="right">
                                  ${tipDollars(Number.parseFloat(workerPct[a.userId]) || 0).toFixed(2)}
                                </Text>
                              </HStack>
                            </HStack>
                          ))}
                          <Text fontSize="xs" fontWeight="medium" color={tipPctValid ? "fg.muted" : "red.600"} pt={1} borderTopWidth="1px" borderColor="green.200">
                            Total {tipPctSum.toFixed(2)}%{!tipPctValid && " — must be 100%"}
                          </Text>
                          {ownerPct > 0 && (
                            <Text fontSize="xs" color="purple.700">
                              Business keeps {effectiveBizPct.toFixed(2)}% —{" "}
                              {(Number.parseFloat(bizPct) || 0).toFixed(2)}% business share +{" "}
                              {ownerPct.toFixed(2)}% owner share (owner earnings are business money).
                            </Text>
                          )}
                        </VStack>
                      )}
                    </VStack>
                  </Box>
                )}

                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Payment method
                  </Text>
                  <Select.Root
                    collection={methodCollection}
                    value={methodKey ? [methodKey] : []}
                    onValueChange={(e) => {
                      setMethodKey(e.value[0] ?? "");
                      setFeeManuallyEdited(false); // method change → snap fee to new estimate
                    }}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Choose…" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {methodCollection.items.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </Box>

                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Payment received on{" "}
                    {paidAt !== bizToday() && (
                      <Text as="span" fontSize="2xs" color="orange.700" fontWeight="normal">
                        — back-dated
                      </Text>
                    )}
                  </Text>
                  <DateInput
                    value={paidAt}
                    onChange={(v) => setPaidAt(v)}
                    max={bizToday()}
                  />
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Defaults to today. Back-date when the money actually
                    landed earlier so cash-basis reports bucket it correctly.
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Note (optional)
                  </Text>
                  <Textarea
                    value={noteStr}
                    onChange={(e) => setNoteStr(e.target.value)}
                    placeholder="Anything to remember about this payment…"
                    rows={2}
                  />
                </Box>

                {hasFee && (
                  <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
                    <VStack align="stretch" gap={2}>
                      <HStack justify="space-between">
                        <Text fontSize="sm" color="fg.muted">Gross charged</Text>
                        <Text fontSize="sm" fontWeight="medium">
                          ${amountValid ? amountNum.toFixed(2) : "—"}
                        </Text>
                      </HStack>
                      <HStack justify="space-between" align="center">
                        <Text fontSize="sm" color="fg.muted">− Processor fee</Text>
                        <Input
                          size="sm"
                          w="100px"
                          textAlign="right"
                          type="number"
                          step="0.01"
                          min={0}
                          max={amountValid ? amountNum : undefined}
                          value={feeStr}
                          onChange={(e) => {
                            setFeeStr(e.target.value);
                            setFeeManuallyEdited(true);
                          }}
                          borderColor={feeValid ? undefined : "red.400"}
                        />
                      </HStack>
                      <Box borderTopWidth="1px" borderColor="gray.200" pt={2}>
                        <HStack justify="space-between">
                          <Text fontSize="sm" fontWeight="semibold">Net received</Text>
                          <Text
                            fontSize="md"
                            fontWeight="bold"
                            color={feeValid ? "green.600" : "red.500"}
                          >
                            {net != null ? `$${net.toFixed(2)}` : "—"}
                          </Text>
                        </HStack>
                      </Box>
                      <Text fontSize="xs" color="fg.muted">
                        Auto-recomputed as{" "}
                        <Text as="span" fontWeight="medium">
                          ${computedFee.toFixed(2)}
                        </Text>{" "}
                        for {selectedMethod?.label ?? "this method"}
                        ({selectedMethod?.feePercent}% + ${selectedMethod?.feeFixed.toFixed(2)}).
                        Override above to match the exact figure on the processor
                        statement — the business absorbs the fee, so worker
                        payouts are unaffected either way.
                      </Text>
                    </VStack>
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button colorPalette="orange" disabled={!canConfirm} onClick={confirm}>
                Approve
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
