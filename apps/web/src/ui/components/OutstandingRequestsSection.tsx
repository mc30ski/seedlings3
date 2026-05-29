"use client";

// Awaiting-client-payment worklist for the Super → Money → Payments tab.
//
// A "Request Payment" sends the client a pay link but creates no payment
// record — so a request the client never acts on can be silently forgotten.
// This section lists every sent-but-unpaid request, oldest first, flags the
// stale ones, and flags requests whose pay link has expired (the client can
// no longer pay even if they want to). Renders nothing when the list is empty.

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Check, ExternalLink, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import PaymentCommsButtons from "@/src/ui/components/PaymentCommsButtons";

type PaymentMethodConfig = {
  key: string;
  label: string;
  feePercent: number;
  feeFixed: number;
  active: boolean;
  supportsClientRequest?: boolean;
  supportsOnSite?: boolean;
};

type OutstandingRow = {
  occurrenceId: string;
  jobId: string | null;
  startAt: string | null;
  requestedAt: string;
  daysSinceRequested: number;
  stale: boolean;
  linkExpiresAt: string | null;
  linkExpired: boolean;
  amount: number;
  property: string | null;
  client: string | null;
  claimer: { id: string; displayName: string | null; email: string | null } | null;
};

function agoLabel(days: number): string {
  if (days <= 0) return "Requested today";
  if (days === 1) return "Requested 1 day ago";
  return `Requested ${days} days ago`;
}

export default function OutstandingRequestsSection() {
  const [rows, setRows] = useState<OutstandingRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Mark Paid dialog state — null when closed, holds the row when open.
  const [markPaidRow, setMarkPaidRow] = useState<OutstandingRow | null>(null);
  const [markPaidAmount, setMarkPaidAmount] = useState("");
  const [markPaidMethod, setMarkPaidMethod] = useState("");
  const [markPaidNote, setMarkPaidNote] = useState("");
  // Processor-fee field is a string so the user can clear/edit freely. It's
  // re-seeded with the computed estimate when method or amount changes; the
  // user can then nudge it to match the actual fee on the processor statement.
  const [markPaidFee, setMarkPaidFee] = useState("");
  const [markPaidBusy, setMarkPaidBusy] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfig[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<OutstandingRow[]>("/api/admin/payment-requests/outstanding");
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load outstanding requests.", err) });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // PAYMENT_METHODS taxonomy — needed for the Mark Paid method picker.
  // Loaded once on mount, reused across multiple Mark Paid invocations.
  useEffect(() => {
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((rows) => {
        const row = Array.isArray(rows) ? rows.find((r) => r.key === "PAYMENT_METHODS") : null;
        if (!row?.value) return;
        try {
          const parsed = JSON.parse(row.value);
          if (Array.isArray(parsed)) {
            setPaymentMethods(parsed.filter((m: any) => m?.active !== false));
          }
        } catch { /* ignore — methods stay empty, picker will be empty */ }
      })
      .catch(() => { /* methods stay empty */ });
  }, []);

  // Estimate the processor fee from the method's percent + fixed config.
  // Matches computeProcessorFee on the server (rounded to 2 decimals).
  function estimateFee(amount: number, methodKey: string): number {
    const cfg = paymentMethods.find((m) => m.key === methodKey);
    if (!cfg) return 0;
    if (!cfg.feePercent && !cfg.feeFixed) return 0;
    const raw = amount * (cfg.feePercent / 100) + cfg.feeFixed;
    return Math.round(raw * 100) / 100;
  }

  function openMarkPaid(row: OutstandingRow) {
    setMarkPaidRow(row);
    setMarkPaidAmount(row.amount.toFixed(2));
    const firstMethod = paymentMethods[0]?.key ?? "";
    setMarkPaidMethod(firstMethod);
    setMarkPaidNote("");
    setMarkPaidFee(estimateFee(row.amount, firstMethod).toFixed(2));
  }

  function closeMarkPaid() {
    setMarkPaidRow(null);
    setMarkPaidAmount("");
    setMarkPaidMethod("");
    setMarkPaidNote("");
    setMarkPaidFee("");
  }

  // Re-seed the fee field whenever the method or amount changes — admin can
  // then override the resulting estimate to match the processor statement.
  function changeMethod(key: string) {
    setMarkPaidMethod(key);
    const amt = Number(markPaidAmount);
    if (Number.isFinite(amt) && amt >= 0) {
      setMarkPaidFee(estimateFee(amt, key).toFixed(2));
    }
  }

  function changeAmount(next: string) {
    setMarkPaidAmount(next);
    const amt = Number(next);
    if (Number.isFinite(amt) && amt >= 0) {
      setMarkPaidFee(estimateFee(amt, markPaidMethod).toFixed(2));
    }
  }

  async function submitMarkPaid() {
    if (!markPaidRow) return;
    const amount = Number(markPaidAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      publishInlineMessage({ type: "WARNING", text: "Enter a valid amount." });
      return;
    }
    if (!markPaidMethod) {
      publishInlineMessage({ type: "WARNING", text: "Pick a payment method." });
      return;
    }
    // Only send a fee override when the admin changed it from the computed
    // estimate. Sending the estimate back would be a no-op but flagging the
    // payment as "manually adjusted" — keep the audit trail honest.
    const cfg = paymentMethods.find((m) => m.key === markPaidMethod);
    const hasFee = cfg ? (cfg.feePercent > 0 || cfg.feeFixed > 0) : false;
    let processorFeeAmount: number | undefined;
    if (hasFee) {
      const fee = Number(markPaidFee);
      if (!Number.isFinite(fee) || fee < 0 || fee > amount) {
        publishInlineMessage({ type: "WARNING", text: "Processor fee must be between 0 and the amount paid." });
        return;
      }
      const computed = estimateFee(amount, markPaidMethod);
      if (Math.abs(fee - computed) >= 0.005) {
        processorFeeAmount = Math.round(fee * 100) / 100;
      }
    }
    setMarkPaidBusy(true);
    try {
      await apiPost(`/api/admin/occurrences/${markPaidRow.occurrenceId}/admin-mark-paid`, {
        amountPaid: amount,
        method: markPaidMethod,
        note: markPaidNote.trim() || null,
        ...(processorFeeAmount !== undefined ? { processorFeeAmount } : {}),
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: "Invoice marked paid — next occurrence generated for repeating jobs.",
      });
      closeMarkPaid();
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Mark paid failed.", err) });
    } finally {
      setMarkPaidBusy(false);
    }
  }

  function openJob(row: OutstandingRow) {
    window.dispatchEvent(
      new CustomEvent("open:jobsTabToServicesTabSearch", {
        detail: {
          q: "",
          forAdmin: true,
          entityId: `${row.jobId ?? ""}:${row.occurrenceId}`,
        },
      }),
    );
  }

  if (rows.length === 0 && !loading) return null;

  const staleCount = rows.filter((r) => r.stale).length;

  return (
    <Card.Root
      variant="outline"
      borderColor="purple.300"
      borderLeftWidth="4px"
      borderLeftColor="purple.500"
      mb={3}
      position="relative"
    >
      {loading && rows.length > 0 && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" borderRadius="md" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>
      )}
      <Card.Body p={3}>
        <HStack mb={1} justify="space-between">
          <HStack gap={2}>
            <Text fontSize="sm" fontWeight="semibold">Awaiting payment</Text>
            <Badge size="sm" colorPalette="purple" variant="solid" px="2" borderRadius="full">
              {rows.length}
            </Badge>
            {staleCount > 0 && (
              <Badge size="sm" colorPalette="orange" variant="solid" px="2" borderRadius="full">
                {staleCount} stale
              </Badge>
            )}
          </HStack>
          <Button size="xs" variant="ghost" onClick={() => void load()} loading={loading}>
            <RefreshCw size={12} />
          </Button>
        </HStack>
        <Text fontSize="xs" color="fg.muted" mb={2}>
          Payment requests sent to a client but not yet paid. They enter the approval queue once the client pays.
        </Text>
        <VStack align="stretch" gap={2}>
          {rows.map((r) => (
            <Box
              key={r.occurrenceId}
              borderWidth="1px"
              borderColor={r.stale ? "orange.300" : "gray.200"}
              bg={r.stale ? "orange.50" : undefined}
              borderRadius="md"
              p={2}
            >
              <HStack justify="space-between" align="start" gap={2}>
                <VStack align="start" gap={1} minW={0} flex={1}>
                  <Text fontSize="sm" fontWeight="medium">
                    {r.property ?? "Job"}
                    {r.client ? ` — ${r.client}` : ""}
                  </Text>
                  <HStack gap={1.5} flexWrap="wrap">
                    <Badge size="sm" colorPalette={r.stale ? "orange" : "gray"}>
                      {agoLabel(r.daysSinceRequested)}
                    </Badge>
                    {r.linkExpired && (
                      <Badge size="sm" colorPalette="red">Pay link expired</Badge>
                    )}
                    <Text fontSize="xs" color="fg.muted">${r.amount.toFixed(2)}</Text>
                  </HStack>
                  {r.claimer && (
                    <Text fontSize="xs" color="fg.muted">
                      Claimer: {r.claimer.displayName ?? r.claimer.email ?? r.claimer.id.slice(-6)}
                    </Text>
                  )}
                </VStack>
              </HStack>
              <HStack gap={2} mt={2} flexWrap="wrap">
                <PaymentCommsButtons
                  occurrenceId={r.occurrenceId}
                  requestSentAt={r.requestedAt}
                  variant="outline"
                  onRequestCanceled={() => void load()}
                />
                <Button size="xs" variant="ghost" onClick={() => openJob(r)} title="Open the job">
                  <ExternalLink size={12} /> Open job
                </Button>
                {/* Admin escape hatch — when the client paid offline and never
                    self-reported, the invoice is stuck here forever. This
                    creates + confirms a Payment row + generates the next
                    occurrence for repeating jobs. */}
                <Button
                  size="xs"
                  variant="solid"
                  colorPalette="green"
                  onClick={() => openMarkPaid(r)}
                  title="Client paid offline — record the payment and close out the invoice"
                >
                  <Check size={12} /> Mark Paid
                </Button>
              </HStack>
            </Box>
          ))}
        </VStack>
      </Card.Body>

      {/* Mark Paid dialog — admin enters method + amount the client paid
          offline. Defaults amount to the invoice's amountDue. On submit,
          posts to /admin/occurrences/.../admin-mark-paid which records a
          confirmed Payment + auto-generates the next occurrence for
          repeating jobs (via the standard approvePayment downstream). */}
      <Dialog.Root
        open={markPaidRow != null}
        onOpenChange={(e) => { if (!e.open) closeMarkPaid(); }}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full">
              <Dialog.Header>
                <Dialog.Title>Mark Invoice Paid</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  {markPaidRow && (
                    <Text fontSize="sm" color="fg.muted">
                      {markPaidRow.property ?? "Job"}
                      {markPaidRow.client ? ` — ${markPaidRow.client}` : ""}
                    </Text>
                  )}
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Amount paid ($)</Text>
                    <Input
                      type="number"
                      step="0.01"
                      value={markPaidAmount}
                      onChange={(e) => changeAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  </Box>
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Method</Text>
                    {paymentMethods.length === 0 ? (
                      <Text fontSize="xs" color="red.600">
                        No payment methods configured. Add some in Settings → PAYMENT_METHODS first.
                      </Text>
                    ) : (
                      <HStack gap={2} wrap="wrap">
                        {paymentMethods.map((m) => (
                          <Button
                            key={m.key}
                            size="sm"
                            variant={markPaidMethod === m.key ? "solid" : "outline"}
                            colorPalette={markPaidMethod === m.key ? "blue" : "gray"}
                            onClick={() => changeMethod(m.key)}
                          >
                            {m.label}
                          </Button>
                        ))}
                      </HStack>
                    )}
                  </Box>
                  {/* Fee + Net breakdown — mirrors ApprovePaymentDialog. Only
                      surfaces for methods with a non-zero fee config. The fee
                      is editable so the admin can match the actual amount
                      from the Venmo/Stripe statement. */}
                  {(() => {
                    const cfg = paymentMethods.find((m) => m.key === markPaidMethod);
                    const hasFee = cfg ? (cfg.feePercent > 0 || cfg.feeFixed > 0) : false;
                    if (!hasFee) return null;
                    const gross = Number(markPaidAmount);
                    const fee = Number(markPaidFee);
                    const feeValid = Number.isFinite(fee) && fee >= 0 && Number.isFinite(gross) && fee <= gross;
                    const net = feeValid ? Math.round((gross - fee) * 100) / 100 : null;
                    return (
                      <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
                        <VStack align="stretch" gap={2}>
                          <HStack justify="space-between">
                            <Text fontSize="sm" color="fg.muted">Gross charged</Text>
                            <Text fontSize="sm" fontWeight="medium">
                              ${Number.isFinite(gross) ? gross.toFixed(2) : "0.00"}
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
                              max={Number.isFinite(gross) ? gross : undefined}
                              value={markPaidFee}
                              onChange={(e) => setMarkPaidFee(e.target.value)}
                              borderColor={feeValid ? undefined : "red.400"}
                            />
                          </HStack>
                          <Box borderTopWidth="1px" borderColor="gray.200" pt={2}>
                            <HStack justify="space-between">
                              <Text fontSize="sm" fontWeight="semibold">Net received</Text>
                              <Text fontSize="md" fontWeight="bold" color={feeValid ? "green.600" : "red.500"}>
                                {net != null ? `$${net.toFixed(2)}` : "—"}
                              </Text>
                            </HStack>
                          </Box>
                          <Text fontSize="xs" color="fg.muted">
                            The fee is an estimate ({cfg!.feePercent}%{cfg!.feeFixed ? ` + $${cfg!.feeFixed.toFixed(2)}` : ""}) —
                            adjust it until Net received matches what actually landed in your {cfg!.label} account.
                            The business absorbs this fee; it never changes worker payouts.
                          </Text>
                        </VStack>
                      </Box>
                    );
                  })()}
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Note (optional)</Text>
                    <Textarea
                      value={markPaidNote}
                      onChange={(e) => setMarkPaidNote(e.target.value)}
                      placeholder="Anything to remember about this payment…"
                      rows={2}
                    />
                  </Box>
                  <Text fontSize="xs" color="fg.muted">
                    This creates a confirmed payment record attributed to you and
                    closes out the invoice. For repeating jobs, the next occurrence
                    is generated automatically.
                  </Text>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack gap={2} justify="end" w="full">
                  <Button size="sm" variant="ghost" onClick={closeMarkPaid} disabled={markPaidBusy}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="green"
                    onClick={() => void submitMarkPaid()}
                    loading={markPaidBusy}
                    disabled={(() => {
                      if (!markPaidMethod || markPaidAmount === "") return true;
                      const cfg = paymentMethods.find((m) => m.key === markPaidMethod);
                      const hasFee = cfg ? (cfg.feePercent > 0 || cfg.feeFixed > 0) : false;
                      if (!hasFee) return false;
                      const gross = Number(markPaidAmount);
                      const fee = Number(markPaidFee);
                      return !(Number.isFinite(fee) && fee >= 0 && Number.isFinite(gross) && fee <= gross);
                    })()}
                  >
                    Mark Paid
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Card.Root>
  );
}
