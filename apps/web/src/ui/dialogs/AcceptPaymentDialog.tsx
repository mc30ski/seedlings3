"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "@/src/lib/api";
import { prettyStatus } from "@/src/lib/lib";

// PAYMENT_METHODS taxonomy row shape. Mirrors the server-side type.
type PaymentMethodConfig = {
  key: string;
  label: string;
  feePercent: number;
  feeFixed: number;
  supportsClientRequest: boolean;
  supportsOnSite: boolean;
  deepLinkTemplate: string | null;
  instructions: string | null;
  active: boolean;
};
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

type HandoffPayload = {
  mode: "SERVER" | "CLAIMER";
  token: string;
  url: string;
  amountDue: number;
  propertyLabel: string;
  smsBody: string;
  emailSubject: string;
  emailBody: string;
  contacts: Array<{ id: string; firstName: string | null; phone: string | null; email: string | null }>;
};

type Assignee = {
  userId: string;
  displayName?: string | null;
  workerType?: string | null;
  /** True for the job's claimer. Receives the leftover 1¢ of a 100/N split
   *  so the percentages always sum to exactly 100. */
  isClaimer?: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string;
  defaultAmount?: number | null;
  /** Base job price (before addons) — for breakdown display */
  basePrice?: number | null;
  /** Total addon amount — for breakdown display */
  addonsTotal?: number;
  totalExpenses?: number;
  commissionPercent?: number;
  marginPercent?: number;
  assignees: Assignee[];
  /** Previously-saved per-worker percentages on the occurrence. If present
   *  the dialog loads them; otherwise it falls back to even-split. */
  completionSplits?: Array<{ userId: string; percent: number }> | null;
  /** Occurrence id — required for the Request Payment footer action
   *  (the dialog fetches /comms-handoff to build the SMS/mailto link). */
  occurrenceId?: string;
  /** Whether Request Payment is enabled org-wide. When false, the button still
   *  renders so workers know the path exists, but it's disabled unless the
   *  viewer is super admin (who bypasses the gate for testing). */
  requestPaymentEnabled?: boolean;
  /** Whether the viewer has SUPER role. Lets super admins use Request Payment
   *  even when the org-wide setting is off (controlled rollout). */
  isSuper?: boolean;
  onAccepted: (result?: any) => void;
};

function isEmployeeClass(wt: string | null | undefined): boolean {
  return wt === "EMPLOYEE" || wt === "TRAINEE";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function AcceptPaymentDialog({
  open,
  onOpenChange,
  endpoint,
  defaultAmount,
  basePrice,
  addonsTotal = 0,
  totalExpenses = 0,
  commissionPercent = 0,
  marginPercent = 0,
  assignees,
  completionSplits,
  occurrenceId,
  requestPaymentEnabled = false,
  isSuper = false,
  onAccepted,
}: Props) {
  const requestPaymentAllowed = requestPaymentEnabled || isSuper;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);

  // PAYMENT_METHODS taxonomy — loaded once on open. Filtered by
  // supportsOnSite for the on-site collection surface. Method dropdown +
  // live fee preview both derive from this.
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfig[]>([]);

  // Amount Paid is intentionally locked to the invoice total inside the
  // main view. The override path lives in the "confirm" step (same dialog,
  // body content morphs), which is the only place the actual received
  // amount can differ from the invoice.
  const [amountPaid, setAmountPaid] = useState("");
  const [method, setMethod] = useState<string[]>([]);
  const [note, setNote] = useState("");
  // View toggle. The same Dialog.Root frame is reused so the user only ever
  // sees one modal at a time.
  //   "form"            — main entry view (locked amount, splits, etc.)
  //   "confirm-accept"  — Accept Now confirm step (amount editable + method + note)
  //   "confirm-request" — Request Payment confirm step (recap + back/send)
  const [view, setView] = useState<"form" | "confirm-accept" | "confirm-request">("form");
  const [confirmAmount, setConfirmAmount] = useState("");
  // Percentages keyed by userId, stored as strings so users can type freely.
  // Validated at submit time to sum to 100 ±0.01.
  const [splits, setSplits] = useState<Record<string, string>>({});
  // Comms-handoff payload (only fetched once per open). Drives the
  // Request Payment footer button — gives us the SMS/mailto href and
  // whether the org is in CLAIMER vs SERVER mode.
  const [handoff, setHandoff] = useState<HandoffPayload | null>(null);

  /**
   * Even percent split using whole-number percentages summing to 100.
   * Floor each worker's share, drop the residual on the claimer's row (or
   * the first assignee when no claimer flag). e.g. 3 workers → 33/33/34.
   */
  function evenSplitPercentMap(): Record<string, string> {
    const map: Record<string, string> = {};
    if (assignees.length === 0) return map;
    const base = Math.floor(100 / assignees.length);
    const remainder = 100 - base * assignees.length;
    const claimerIdx = (() => {
      const i = assignees.findIndex((a) => a.isClaimer);
      return i >= 0 ? i : 0;
    })();
    assignees.forEach((a, idx) => {
      const v = base + (idx === claimerIdx ? remainder : 0);
      map[a.userId] = String(v);
    });
    return map;
  }

  // Seed form ONCE per dialog open (transition closed → open). Re-running
  // on every prop-identity change while open would stomp on what the
  // operator typed when the parent re-renders (e.g. the JobsTab reload
  // poll). The latest prop values are still captured inside the effect
  // body via closure at the moment of opening — we just don't want
  // additional re-seeds while the dialog is up.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const amt = defaultAmount != null ? defaultAmount.toFixed(2) : "";
      setAmountPaid(amt);
      // Intentionally unset — forces the worker to pick CASH/CHECK/etc.
      // explicitly so they don't auto-record the wrong method.
      setMethod([]);
      setNote("");
      setView("form");
      setConfirmAmount(amt);
      if (occurrenceId) {
        setHandoff(null);
        apiGet<HandoffPayload>(`/api/occurrences/${occurrenceId}/comms-handoff`)
          .then((d) => setHandoff(d))
          .catch(() => setHandoff(null));
      }
      // Load PAYMENT_METHODS taxonomy for the dropdown + live fee preview.
      // Filter by supportsOnSite + active at render time below.
      apiGet<Array<{ key: string; value: string }>>("/api/settings")
        .then((rows) => {
          if (!Array.isArray(rows)) return setPaymentMethods([]);
          const row = rows.find((r) => r.key === "PAYMENT_METHODS");
          if (!row?.value) return setPaymentMethods([]);
          try {
            const parsed = JSON.parse(row.value);
            if (Array.isArray(parsed)) setPaymentMethods(parsed as PaymentMethodConfig[]);
          } catch {
            setPaymentMethods([]);
          }
        })
        .catch(() => setPaymentMethods([]));
      // Initialize percent splits: prefer the occurrence's previously-saved
      // completionSplits (so re-opening after a reject shows last values);
      // fall back to even-split when null/empty or assignees differ.
      if (assignees.length > 0) {
        const fromSaved: Record<string, string> = {};
        let coverageOk = false;
        if (Array.isArray(completionSplits) && completionSplits.length > 0) {
          const byId = new Map(completionSplits.map((s) => [s.userId, s.percent]));
          coverageOk = assignees.every((a) => byId.has(a.userId));
          if (coverageOk) {
            assignees.forEach((a) => {
              const v = byId.get(a.userId) ?? 0;
              // Saved splits may be fractional from earlier code; coerce to
              // whole integer for the now-integer-only input.
              fromSaved[a.userId] = String(Math.round(v));
            });
          }
        }
        setSplits(coverageOk ? fromSaved : evenSplitPercentMap());
      } else {
        setSplits({});
      }
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Derive dropdown items from the loaded taxonomy. Only active + supportsOnSite
  // methods appear in the worker on-site dialog. Falls back to an empty list
  // (with a visible "no methods configured" message) if the taxonomy hasn't
  // loaded — better than silently using stale hardcoded values.
  const onSiteMethods = useMemo(
    () => paymentMethods.filter((m) => m.active && m.supportsOnSite),
    [paymentMethods],
  );
  const methodItems = useMemo(
    () => onSiteMethods.map((m) => ({ label: m.label, value: m.key })),
    [onSiteMethods],
  );
  const methodCollection = useMemo(
    () => createListCollection({ items: methodItems }),
    [methodItems],
  );
  // Look up the currently-selected method's fee config so we can render a
  // live "Venmo fee: $3.90" line in the confirm view.
  const selectedMethodConfig = useMemo(
    () => onSiteMethods.find((m) => m.key === method[0]) ?? null,
    [onSiteMethods, method],
  );
  const liveFee = useMemo(() => {
    const amt = parseFloat(confirmAmount || amountPaid);
    if (!Number.isFinite(amt) || amt <= 0 || !selectedMethodConfig) {
      return { gross: 0, fee: 0, net: 0 };
    }
    const pct = Math.max(0, selectedMethodConfig.feePercent);
    const fixed = Math.max(0, selectedMethodConfig.feeFixed);
    const rawFee = amt * (pct / 100) + fixed;
    const fee = Math.round(rawFee * 100) / 100;
    return { gross: amt, fee, net: Math.round((amt - fee) * 100) / 100 };
  }, [confirmAmount, amountPaid, selectedMethodConfig]);

  // Per-worker breakdown for the entered amount, using the canonical
  // per-worker math (mirrors server's computeBreakdown).
  //   N         = amount − expenses
  //   gross_i   = N × percent_i / 100
  //   rate_i    = contractorFee or employeeMargin (based on workerType)
  //   fee_i     = gross_i × rate_i / 100
  //   net_i     = gross_i − fee_i
  // Total payout to workers = Σ net_i. Class fee totals split out for
  // the summary card. Falls back to zero values when amount is empty.
  const breakdown = useMemo(() => {
    const amt = parseFloat(amountPaid);
    const validAmount = Number.isFinite(amt) && amt > 0;
    const N = validAmount ? Math.max(0, amt - totalExpenses) : 0;
    const rows = assignees.map((a) => {
      const pctStr = splits[a.userId] || "0";
      const pct = Number.parseFloat(pctStr);
      const percent = Number.isFinite(pct) ? pct : 0;
      const isEmp = isEmployeeClass(a.workerType);
      const ratePercent = isEmp ? marginPercent : commissionPercent;
      const gross = N * (percent / 100);
      const fee = gross * (ratePercent / 100);
      const net = gross - fee;
      return {
        userId: a.userId,
        displayName: a.displayName || a.userId,
        workerType: a.workerType ?? null,
        percent,
        ratePercent,
        gross: round2(gross),
        fee: round2(fee),
        net: round2(net),
        isEmployeeClass: isEmp,
      };
    });
    const platformFeeTotal = round2(rows.filter((r) => !r.isEmployeeClass).reduce((s, r) => s + r.fee, 0));
    const businessMarginTotal = round2(rows.filter((r) => r.isEmployeeClass).reduce((s, r) => s + r.fee, 0));
    const totalPayout = round2(rows.reduce((s, r) => s + r.net, 0));
    return { rows, platformFeeTotal, businessMarginTotal, totalPayout, validAmount, N: round2(N) };
  }, [amountPaid, assignees, splits, totalExpenses, commissionPercent, marginPercent]);

  const percentSum = useMemo(() => {
    return assignees.reduce((s, a) => {
      const v = Number.parseInt(splits[a.userId] || "0", 10);
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);
  }, [splits, assignees]);

  const splitsValid = useMemo(() => {
    if (assignees.length === 0) return false;
    if (percentSum !== 100) return false;
    for (const a of assignees) {
      const raw = splits[a.userId] || "";
      const v = Number.parseInt(raw, 10);
      if (!Number.isFinite(v) || v <= 0) return false;
      // Reject anything that isn't a whole integer (e.g. "33.5", "33.")
      if (String(v) !== raw.trim()) return false;
    }
    return true;
  }, [splits, assignees, percentSum]);

  function evenSplit() {
    setSplits(evenSplitPercentMap());
  }

  // Fire the Request Payment path. Persists the percent splits onto the
  // occurrence in the same call, so the eventual admin approval has them
  // ready. In SERVER mode the server already sent the request when the
  // job hit PENDING_PAYMENT; we still update splits and close. In CLAIMER
  // mode we open the device SMS/mailto handler in the user gesture.
  function handleRequestPayment() {
    if (!handoff || !occurrenceId) {
      publishInlineMessage({ type: "WARNING", text: "Couldn't load contact info — refresh and try again." });
      return;
    }
    if (!splitsValid) {
      publishInlineMessage({ type: "WARNING", text: "Set per-worker percentages so they sum to 100% first." });
      return;
    }
    const splitsPayload = assignees.map((a) => ({
      userId: a.userId,
      percent: Number.parseInt(splits[a.userId] || "0", 10),
    }));
    if (handoff.mode === "SERVER") {
      // SERVER mode: server already fired the comms; we just save splits.
      setRequestBusy(true);
      apiPost(`/api/occurrences/${occurrenceId}/completion-splits`, {
        completionSplits: splitsPayload,
      })
        .then(() => {
          publishInlineMessage({
            type: "INFO",
            text: "Payment request already sent when the job completed. Splits saved.",
          });
          onOpenChange(false);
          onAccepted({ requestSent: true });
        })
        .catch((err) => {
          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to save splits.", err) });
        })
        .finally(() => setRequestBusy(false));
      return;
    }
    const phoneContact = handoff.contacts.find((c) => c.phone);
    const emailContact = handoff.contacts.find((c) => c.email);
    if (!phoneContact && !emailContact) {
      publishInlineMessage({
        type: "ERROR",
        text: "Client has no phone or email on file. Add contact info before requesting payment.",
      });
      return;
    }
    const useSms = !!phoneContact?.phone;
    const href = useSms
      ? `sms:${phoneContact!.phone}?&body=${encodeURIComponent(handoff.smsBody)}`
      : `mailto:${emailContact!.email}?subject=${encodeURIComponent(handoff.emailSubject)}&body=${encodeURIComponent(handoff.emailBody)}`;
    // Open the device handler in the user gesture, then audit + close.
    window.location.href = href;
    setRequestBusy(true);
    apiPost(`/api/occurrences/${occurrenceId}/comms-handoff`, {
      channel: useSms ? "sms" : "email",
      completionSplits: splitsPayload,
    })
      .then(() => {
        publishInlineMessage({ type: "SUCCESS", text: "Payment request sent." });
        onOpenChange(false);
        onAccepted({ requestSent: true });
      })
      .catch((err) => {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to record request.", err) });
      })
      .finally(() => setRequestBusy(false));
  }

  // Called by the Accept Now confirm dialog with the (possibly-adjusted)
  // actual amount received. The Amount Paid field on the main dialog stays
  // locked to the invoice total; this is the single override point.
  async function handleAcceptConfirmed(amountReceived: number) {
    if (!Number.isFinite(amountReceived) || amountReceived < 0) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a valid amount." });
      return;
    }
    if (!method[0]) {
      publishInlineMessage({ type: "WARNING", text: "Please select a payment method." });
      return;
    }
    if (!splitsValid) {
      publishInlineMessage({ type: "WARNING", text: "Per-worker percentages must sum to 100%, and every worker needs a positive share." });
      return;
    }

    const splitsPayload = assignees.map((a) => ({
      userId: a.userId,
      percent: Number.parseInt(splits[a.userId] || "0", 10),
    }));

    setBusy(true);
    try {
      const result = await apiPost<any>(endpoint, {
        amountPaid: amountReceived,
        method: method[0],
        note: note.trim() || null,
        completionSplits: splitsPayload,
      });
      publishInlineMessage({
        type: "INFO",
        text: "Payment submitted for admin approval. The job stays in Pending Payment until admin verifies.",
      });
      onOpenChange(false);
      onAccepted(result);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Accept payment failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {view === "confirm-accept"
                  ? "Confirm payment received"
                  : view === "confirm-request"
                    ? "Send payment request?"
                    : "Initiate Payment"}
              </Dialog.Title>
            </Dialog.Header>

            {view === "confirm-accept" ? (
              <>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Box
                      p={3}
                      bg="blue.50"
                      borderWidth="1px"
                      borderColor="blue.300"
                      borderLeftWidth="4px"
                      borderLeftColor="blue.500"
                      rounded="md"
                    >
                      <Text fontSize="sm" color="blue.900">
                        Enter the amount you actually received. Defaults to the invoice total — only change it if the amount was different.
                      </Text>
                    </Box>
                    <div>
                      <Text mb="1">Amount received *</Text>
                      <CurrencyInput value={confirmAmount} onChange={setConfirmAmount} size="sm" />
                    </div>
                    <div>
                      <Text mb="1">Payment Method *</Text>
                      <Select.Root
                        collection={methodCollection}
                        value={method}
                        onValueChange={(e) => setMethod(e.value)}
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder="Select method" />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {methodItems.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </div>
                    {/* Live processor-fee preview. Hidden entirely for zero-
                        fee methods (Cash, Check, Zelle as configured). For
                        fee-bearing methods, shows gross / fee / net so the
                        worker can see exactly what hits the bank account. */}
                    {selectedMethodConfig && liveFee.fee > 0 && (
                      <Box p={2} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.200">
                        <VStack align="stretch" gap={0.5} fontSize="xs">
                          <HStack justify="space-between">
                            <Text color="fg.muted">Gross charged:</Text>
                            <Text fontWeight="medium">${liveFee.gross.toFixed(2)}</Text>
                          </HStack>
                          <HStack justify="space-between">
                            <Text color="orange.700">
                              {selectedMethodConfig.label} fee
                              {selectedMethodConfig.feePercent > 0
                                ? ` (${selectedMethodConfig.feePercent}%${selectedMethodConfig.feeFixed > 0 ? ` + $${selectedMethodConfig.feeFixed.toFixed(2)}` : ""})`
                                : selectedMethodConfig.feeFixed > 0
                                  ? ` ($${selectedMethodConfig.feeFixed.toFixed(2)})`
                                  : ""}:
                            </Text>
                            <Text color="orange.700" fontWeight="medium">−${liveFee.fee.toFixed(2)}</Text>
                          </HStack>
                          <HStack justify="space-between" borderTopWidth="1px" borderColor="orange.200" pt={0.5} mt={0.5}>
                            <Text fontWeight="semibold">Net received:</Text>
                            <Text fontWeight="semibold">${liveFee.net.toFixed(2)}</Text>
                          </HStack>
                        </VStack>
                      </Box>
                    )}
                    <div>
                      <Text mb="1">Note</Text>
                      <Input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="e.g. check #1234"
                        size="sm"
                      />
                    </div>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="flex-end" w="full" wrap="wrap" gap={2}>
                    <Button
                      variant="ghost"
                      onClick={() => setView("form")}
                      disabled={busy}
                      size="sm"
                    >
                      Back
                    </Button>
                    <Button
                      variant="solid"
                      colorPalette="green"
                      onClick={() => {
                        const parsed = Number.parseFloat((confirmAmount ?? "").trim());
                        if (!Number.isFinite(parsed) || parsed < 0) {
                          publishInlineMessage({ type: "ERROR", text: "Enter a valid amount." });
                          return;
                        }
                        void handleAcceptConfirmed(parsed);
                      }}
                      loading={busy}
                      disabled={!confirmAmount || !method[0] || (() => {
                        const amt = parseFloat(confirmAmount);
                        return isNaN(amt) || amt < 0;
                      })()}
                      size="sm"
                    >
                      Confirm Accept Now
                    </Button>
                  </HStack>
                </Dialog.Footer>
              </>
            ) : view === "confirm-request" ? (
              <>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    {(() => {
                      const phoneContact = handoff?.contacts.find((c) => c.phone) ?? null;
                      const emailContact = handoff?.contacts.find((c) => c.email) ?? null;
                      const channel: "sms" | "email" | "server" | "none" =
                        handoff?.mode === "SERVER"
                          ? "server"
                          : phoneContact?.phone
                            ? "sms"
                            : emailContact?.email
                              ? "email"
                              : "none";
                      return (
                        <>
                          <Box
                            p={3}
                            bg="blue.50"
                            borderWidth="1px"
                            borderColor="blue.300"
                            borderLeftWidth="4px"
                            borderLeftColor="blue.500"
                            rounded="md"
                          >
                            <Text fontSize="sm" color="blue.900">
                              {channel === "server" && (
                                <>The payment request was already sent. Confirming will save the per-worker splits. Once the client indicates payment, an admin will review before the job is closed.</>
                              )}
                              {channel === "sms" && (
                                <>Your text app will open with a pre-filled message. Send it from there. Once the client indicates payment, an admin will review before the job is closed.</>
                              )}
                              {channel === "email" && (
                                <>Your email app will open with a pre-filled message. Send it from there. Once the client indicates payment, an admin will review before the job is closed.</>
                              )}
                              {channel === "none" && (
                                <Text color="red.700">
                                  This client has no phone or email on file. Add one before requesting payment.
                                </Text>
                              )}
                            </Text>
                          </Box>
                          <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                            <VStack align="stretch" gap={0.5} fontSize="xs">
                              <HStack justify="space-between"><Text>Amount to request</Text><Text fontWeight="semibold">${(parseFloat(amountPaid) || 0).toFixed(2)}</Text></HStack>
                              <HStack justify="space-between"><Text>Property</Text><Text fontWeight="semibold" truncate>{handoff?.propertyLabel ?? "—"}</Text></HStack>
                            </VStack>
                          </Box>
                        </>
                      );
                    })()}
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="flex-end" w="full" wrap="wrap" gap={2}>
                    <Button
                      variant="ghost"
                      onClick={() => setView("form")}
                      disabled={requestBusy}
                      size="sm"
                    >
                      Back
                    </Button>
                    <Button
                      variant="solid"
                      colorPalette="green"
                      onClick={handleRequestPayment}
                      loading={requestBusy}
                      disabled={
                        !handoff ||
                        (() => {
                          if (handoff?.mode === "SERVER") return false;
                          const hasPhone = !!handoff?.contacts.find((c) => c.phone);
                          const hasEmail = !!handoff?.contacts.find((c) => c.email);
                          return !hasPhone && !hasEmail;
                        })()
                      }
                      size="sm"
                    >
                      Send Request
                    </Button>
                  </HStack>
                </Dialog.Footer>
              </>
            ) : (
              <>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box
                  p={3}
                  bg="blue.50"
                  borderWidth="1px"
                  borderColor="blue.300"
                  borderLeftWidth="4px"
                  borderLeftColor="blue.500"
                  rounded="md"
                >
                  <Text fontSize="sm" color="blue.900">
                    <Text as="span" fontWeight="semibold">Request Payment</Text> sends the client a message with a link to pay the invoice.{" "}
                    <Text as="span" fontWeight="semibold">Accept Now</Text> records a direct payment (e.g. cash on-site).
                    Either way the payment will be reviewed by an admin before the job closes.
                  </Text>
                </Box>

                <div>
                  <Text mb="1">Amount Due</Text>
                  <CurrencyInput value={amountPaid} onChange={() => {}} size="sm" disabled />
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Locked to the invoice total. If the cash/check you actually received is different, you can adjust it when you confirm Accept Now.
                  </Text>
                </div>

                {/* Single live summary — invoice composition, what's being
                    paid, what comes off the top, and what the workers end up
                    receiving. Updates as amount / splits change above. */}
                {(() => {
                  const parsed = parseFloat(amountPaid);
                  const enteredAmount = Number.isFinite(parsed) ? parsed : 0;
                  const invoiceTotal = (basePrice ?? 0) + addonsTotal;
                  const differs = Math.abs(enteredAmount - invoiceTotal) > 0.01 && enteredAmount > 0;
                  return (
                    <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                      <VStack align="stretch" gap={0.5} fontSize="xs">
                        <HStack justify="space-between" color="fg.muted">
                          <Text>Base price</Text>
                          <Text>${(basePrice ?? 0).toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color={addonsTotal > 0 ? "green.700" : "fg.muted"}>
                          <Text>+ Add-ons</Text>
                          <Text>${addonsTotal.toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color="fg.muted">
                          <Text>= Invoice</Text>
                          <Text>${invoiceTotal.toFixed(2)}</Text>
                        </HStack>
                        <Box borderTopWidth="1px" borderColor="gray.300" my={1} />
                        <HStack justify="space-between" fontWeight="semibold" color={differs ? "orange.600" : undefined}>
                          <Text>Amount paid</Text>
                          <Text>${enteredAmount.toFixed(2)}</Text>
                        </HStack>
                        {differs && (
                          <Text fontSize="2xs" color="orange.600" textAlign="right">
                            ({enteredAmount > invoiceTotal ? "over" : "under"} invoice by ${Math.abs(enteredAmount - invoiceTotal).toFixed(2)})
                          </Text>
                        )}
                        <HStack justify="space-between" color={totalExpenses > 0 ? "orange.600" : "fg.muted"}>
                          <Text>− Expenses</Text>
                          <Text>${totalExpenses.toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color={breakdown.platformFeeTotal > 0 ? "orange.600" : "fg.muted"}>
                          <Text>− Platform fee ({commissionPercent}% of contractor shares)</Text>
                          <Text>${breakdown.platformFeeTotal.toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color={breakdown.businessMarginTotal > 0 ? "orange.600" : "fg.muted"}>
                          <Text>− Business margin ({marginPercent}% of employee shares)</Text>
                          <Text>${breakdown.businessMarginTotal.toFixed(2)}</Text>
                        </HStack>
                        <Box borderTopWidth="1px" borderColor="gray.300" my={1} />
                        <HStack justify="space-between" fontWeight="bold">
                          <Text>Workers receive</Text>
                          <Text color="green.700">${breakdown.totalPayout.toFixed(2)}</Text>
                        </HStack>
                      </VStack>
                    </Box>
                  );
                })()}

                {/* Per-Person Split — percentages that must sum to 100. Live
                    per-worker preview shows each worker's $net for the
                    current amount + their own worker-type rate. */}
                {assignees.length > 0 && (
                  <div>
                    <HStack justify="space-between" mb="1">
                      <Text>Per-Person Split (whole % of payment)</Text>
                      {assignees.length > 1 && (
                        <Button size="xs" variant="ghost" onClick={evenSplit}>
                          Even Split
                        </Button>
                      )}
                    </HStack>
                    <VStack align="stretch" gap={2}>
                      {breakdown.rows.map((r) => (
                        <HStack key={r.userId} gap={2} align="center">
                          <VStack align="start" gap={0} flex="1" minW={0}>
                            <HStack gap={1.5}>
                              <Text fontSize="sm" truncate>
                                {r.displayName}
                              </Text>
                              {r.workerType && (
                                <Badge
                                  size="xs"
                                  variant="subtle"
                                  colorPalette={r.isEmployeeClass ? "blue" : "purple"}
                                >
                                  {r.workerType === "TRAINEE" ? "Trainee" : r.isEmployeeClass ? "Employee" : "Contractor"}
                                </Badge>
                              )}
                            </HStack>
                            {breakdown.validAmount && r.percent > 0 && (
                              <Text fontSize="xs" color="fg.muted">
                                ${r.gross.toFixed(2)} gross
                                {r.fee > 0 && <> − ${r.fee.toFixed(2)} {r.isEmployeeClass ? "margin" : "fee"} ({r.ratePercent}%)</>}
                                {" = "}
                                <Text as="span" color="green.700" fontWeight="semibold">${r.net.toFixed(2)}</Text>
                              </Text>
                            )}
                          </VStack>
                          <HStack gap={1} align="center" flexShrink={0}>
                            <Input
                              // type="text" instead of type="number" because
                              // number inputs hijack the scroll wheel (and
                              // up/down arrow keys) to change the value —
                              // when the user scrolls the dialog and the
                              // cursor passes over a focused input, the
                              // percent ticks unexpectedly. inputMode keeps
                              // the mobile numeric keypad; the onChange
                              // regex enforces digits-only.
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={3}
                              size="sm"
                              width="20"
                              textAlign="right"
                              value={splits[r.userId] || ""}
                              disabled={assignees.length === 1}
                              onChange={(e) => {
                                // Strip non-digits so the field stays whole-integer.
                                const cleaned = e.target.value.replace(/[^\d]/g, "");
                                setSplits((prev) => ({ ...prev, [r.userId]: cleaned }));
                              }}
                            />
                            <Text fontSize="sm">%</Text>
                          </HStack>
                        </HStack>
                      ))}
                    </VStack>
                    <HStack
                      justify="space-between"
                      mt={2}
                      pt={2}
                      borderTopWidth="1px"
                      borderColor="gray.200"
                    >
                      <Text fontSize="xs" color={percentSum !== 100 ? "red.600" : "fg.muted"}>
                        {percentSum !== 100
                          ? `Splits sum to ${percentSum}% — must be 100%`
                          : "Splits sum to 100% ✓"}
                      </Text>
                      <Text fontSize="xs" fontWeight="semibold">
                        {percentSum}%
                      </Text>
                    </HStack>
                  </div>
                )}

              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full" wrap="wrap" gap={2}>
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy || requestBusy}
                  size="sm"
                >
                  Cancel
                </Button>
                {occurrenceId && (
                  <Button
                    variant="solid"
                    colorPalette="green"
                    onClick={() => setView("confirm-request")}
                    loading={requestBusy}
                    disabled={
                      !requestPaymentAllowed ||
                      busy ||
                      !handoff ||
                      !splitsValid ||
                      !amountPaid ||
                      (() => {
                        const amt = parseFloat(amountPaid);
                        return isNaN(amt) || amt <= 0;
                      })()
                    }
                    title={!requestPaymentAllowed ? "Request Payment is currently disabled by an admin." : undefined}
                    size="sm"
                  >
                    Request Payment
                  </Button>
                )}
                <Button
                  variant="outline"
                  colorPalette="gray"
                  onClick={() => {
                    // Seed the confirm step with the current locked amount
                    // each time the user opens it, in case the form-level
                    // amount changed (it shouldn't, but be safe).
                    setConfirmAmount(amountPaid);
                    setView("confirm-accept");
                  }}
                  loading={busy}
                  size="sm"
                  disabled={
                    requestBusy ||
                    !amountPaid ||
                    !splitsValid ||
                    (() => {
                      const amt = parseFloat(amountPaid);
                      return isNaN(amt) || amt <= 0;
                    })()
                  }
                >
                  Accept Now
                </Button>
              </HStack>
            </Dialog.Footer>
              </>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
