"use client";
import {
  classify,
  computeBreakdown,
  cannotBePriced,
  isPaid,
  reconcileApproval,
  round2,
  type Rates,
  type WorkerInput,
  type WorkerType,
} from "@repo/money";

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
import { bumpPayments } from "@/src/lib/bus";
import { buildMailtoHref, buildSmsHref, fetchCommsCc } from "@/src/lib/comms";
import { prettyStatus } from "@/src/lib/labels";
import { composePaymentMessage } from "@/src/lib/paymentMessages";

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
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";
import { isW2 } from "@repo/money";
import { payClassLabel } from "../../lib/paymentMath";

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
  missingPrimaryContact?: boolean;
};

type Assignee = {
  userId: string;
  displayName?: string | null;
  workerType?: WorkerType | null;
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
  /** Material lines billed on top of the work. Without this the dialog shows
   *  — and pre-fills — the CREW POOL as though it were the invoice, which
   *  under-collects by exactly the materials. */
  materialChargesTotal?: number;
  totalInvoiceCharges?: number;
  commissionPercent?: number;
  marginPercent?: number;
  assignees: Assignee[];
  /** Previously-saved per-worker percentages on the occurrence. If present
   *  the dialog loads them; otherwise it falls back to even-split. */
  completionSplits?: Array<{ userId: string; percent: number }> | null;
  /** Occurrence id — required for the Request Payment footer action
   *  (the dialog fetches /comms-handoff to build the SMS/mailto link). */
  occurrenceId?: string;
  /** Bypasses the REQUEST_PAYMENT_FROM_CLIENT_ENABLED gate: when that
   *  setting is "false" the Request Payment button is hidden, but stays
   *  available to whoever this is true for. Every callsite passes
   *  `scope.can("schedule.manage")`.
   *
   *  Was a role flag — a testing hatch for the kill-switch. Widened on
   *  purpose: a requested payment still lands in the approval queue for
   *  review, so the safety is the approval step, not hiding the button.
   *
   *  NOTE: the gate is enforced in the browser only. No API route reads
   *  the setting. */
  isOperator?: boolean;
  /** Adds a "Client paid another way?" link that expands the method picker
   *  from on-site methods to ALL active methods — for recording a payment a
   *  client made remotely (e.g. an unprompted Venmo) on their behalf. Passed
   *  as `scope.can("schedule.manage")` from JobsTab; off by default, so a
   *  field caller's on-site flow stays uncluttered. */
  allowAllMethods?: boolean;
  /** Display name of the impersonated person when viewing-as a single
   *  person; renders the inline impersonation warning. */
  viewAsName?: string | null;
  onAccepted: (result?: any) => void;
};

/**
 * THE HAND-ROLLED PAYOUT MATH THAT USED TO LIVE HERE IS GONE.
 *
 * A local `shareRate()` picked the rate off a worker type and a local
 * `round2()` rounded it, and the breakdown below multiplied them out by
 * hand. `@repo/money` already owns that math, and its own header says
 * exactly why:
 *
 *   "A forecasting tool that reimplements payout math drifts from
 *    production the first time a rate rule changes — silently, while still
 *    looking authoritative. So the simulator is not allowed its own copy."
 *
 * This dialog was that copy, and it had drifted three ways (measured
 * 2026-11-13):
 *
 *   1. THE WRONG SERVER FUNCTION. The comment claimed it mirrored
 *      `computeBreakdown`. The approval path is `reconcileApproval`, which
 *      wraps it and THEN applies the make-whole rules: a W-2 worker is paid
 *      their promised net with the business absorbing the shortfall, while
 *      a contractor takes the pro-rata loss. The copy had no notion of a
 *      promise, so on a $300 invoice paid $150 it showed an employee
 *      $52.50 where the server pays $105.
 *   2. NO PENNY RESIDUAL. `computeBreakdown` spreads the rounding residual
 *      one cent per row — added because dumping it on row 0 systematically
 *      shortchanged the claimer. Across 4.2M submittable combinations the
 *      copy disagreed with the server on 47% of amounts, by a cent a
 *      worker.
 *   3. NO NORMALISATION. `computeBreakdown` normalises the percentages over
 *      their own sum; the copy used them raw. Only visible mid-edit, since
 *      submit is blocked unless they total 100.
 *
 * The server was right in every case — it was the preview, on the screen
 * where money is approved, that was wrong.
 */
export default function AcceptPaymentDialog({
  open,
  onOpenChange,
  endpoint,
  defaultAmount,
  basePrice,
  addonsTotal = 0,
  materialChargesTotal = 0,
  totalInvoiceCharges = 0,
  commissionPercent = 0,
  marginPercent = 0,
  assignees,
  completionSplits,
  occurrenceId,
  isOperator = false,
  allowAllMethods = false,
  viewAsName = null,
  onAccepted,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const dlgErr = useDialogError();

  // PAYMENT_METHODS taxonomy — loaded once on open. Filtered by
  // supportsOnSite for the on-site collection surface. Method dropdown +
  // live fee preview both derive from this.
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfig[]>([]);
  // When true, the method picker shows ALL active methods, not just on-site
  // ones. Only togglable when `allowAllMethods` is set (`schedule.manage`) —
  // used to record a payment the client made through a remote channel.
  const [showAllMethods, setShowAllMethods] = useState(false);
  // Kill-switch for the Request Payment button. Workers see the button only
  // when this is "true"; `schedule.manage` always sees it so the toggle can be tested
  // without losing access. Defaults to enabled on missing/unparseable rows.
  const [requestPaymentEnabled, setRequestPaymentEnabled] = useState(true);
  useEffect(() => {
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const row = rows.find((r) => r.key === "REQUEST_PAYMENT_FROM_CLIENT_ENABLED");
        if (row) setRequestPaymentEnabled(row.value === "true");
      })
      .catch(() => { /* keep default */ });
  }, []);
  const canRequestPayment = requestPaymentEnabled || isOperator;

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
      setShowAllMethods(false);
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

  // Derive dropdown items from the loaded taxonomy. Default: active +
  // supportsOnSite (the field-collection set). When the Jobs tab opened
  // the dialog AND the operator tapped "Client paid another way?", widen to
  // ALL active methods so a remotely-made payment can be recorded.
  const availableMethods = useMemo(() => {
    const active = paymentMethods.filter((m) => m.active);
    return allowAllMethods && showAllMethods
      ? active
      : active.filter((m) => m.supportsOnSite);
  }, [paymentMethods, allowAllMethods, showAllMethods]);
  const methodItems = useMemo(
    () => availableMethods.map((m) => ({ label: m.label, value: m.key })),
    [availableMethods],
  );
  const methodCollection = useMemo(
    () => createListCollection({ items: methodItems }),
    [methodItems],
  );
  // Look up the currently-selected method's fee config so we can render a
  // live "Venmo fee: $3.90" line in the confirm view. Resolve against ALL
  // active methods (not just the visible subset) so the fee still renders if
  // the list was just narrowed back down.
  const selectedMethodConfig = useMemo(
    () => paymentMethods.find((m) => m.active && m.key === method[0]) ?? null,
    [paymentMethods, method],
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

  /**
   * WHAT EACH WORKER WILL ACTUALLY BE PAID, from the shared money package.
   *
   * Two canonical calls, in the same order and on the same inputs the
   * server uses:
   *
   *   promised = computeBreakdown(invoiceTotal, charges, workers, rates)
   *   outcome  = reconcileApproval(entered, charges, workers, promised, rates)
   *
   * The PROMISE is reproducible here rather than fetched: `payments.ts`
   * snapshots it as `computeBreakdown(invoiceTotal(occ), materialCharges,
   * splits, rates)` at payment-creation time, which is the moment this
   * dialog submits. Every one of those inputs is already a prop. (It is not
   * fetched because it does not exist yet — the snapshot is written BY the
   * submission this dialog is previewing.)
   *
   * `outcome.splits[i].amount` is the figure that becomes `PaymentSplit.
   * amount`, so that is what the row shows. `netAmount` is the pre-make-whole
   * value and `topUpAmount` the difference — surfaced below, because an
   * employee being topped up out of the business's side is the single most
   * surprising thing on this screen and the old preview hid it.
   */
  const breakdown = useMemo(() => {
    const amt = parseFloat(amountPaid);
    const validAmount = Number.isFinite(amt) && amt > 0;
    const rates: Rates = {
      employeeMarginPercent: marginPercent,
      contractorFeePercent: commissionPercent,
    };

    const pctOf = (userId: string) => {
      const v = Number.parseFloat(splits[userId] || "0");
      return Number.isFinite(v) ? v : 0;
    };

    // SOMEONE THE MONEY SYSTEM CANNOT PRICE IS SEPARATED OUT FIRST.
    //
    // `rateFor` THROWS for UNPAID and for an untyped worker rather than
    // guessing — "a crash is recoverable; a wrong figure in a 1099 is not"
    // — so handing one to `computeBreakdown` would take the dialog down.
    // Both call sites filter observers and G33 says a non-observer assignee
    // must be EMPLOYEE or CONTRACTOR, so this should be empty; a legacy row
    // can still carry one, and the old code quietly showed them a $0 share.
    //
    // Quietly is the problem. The server refuses this payment outright for
    // the same reason, so the honest preview is a warning, not a zero.
    const priceable = assignees.filter((a) => isPaid(a.workerType ?? null));
    const unpriceable = assignees.filter((a) => cannotBePriced(a.workerType ?? null));

    const workers: WorkerInput[] = priceable.map((a) => ({
      userId: a.userId,
      workerType: (a.workerType ?? null) as WorkerType | null,
      splitPercent: pctOf(a.userId),
    }));

    // The full invoice, materials included — `computeBreakdown` subtracts
    // the charges itself to reach the crew pool, so feeding it labour-only
    // would pay the crew out of a number the client was never billed.
    const invoice = (basePrice ?? 0) + addonsTotal + materialChargesTotal;
    const promised = workers.length
      ? computeBreakdown(invoice, totalInvoiceCharges, workers, rates)
      : [];
    const outcome =
      validAmount && workers.length
        ? reconcileApproval(amt, totalInvoiceCharges, workers, promised, rates)
        : null;

    const finalById = new Map((outcome?.splits ?? []).map((r) => [r.userId, r]));
    const promisedById = new Map(promised.map((r) => [r.userId, r]));

    const rows = assignees.map((a) => {
      const payClass = isPaid(a.workerType ?? null) ? classify(a.workerType ?? null) : null;
      const fin = finalById.get(a.userId);
      const pro = promisedById.get(a.userId);
      return {
        userId: a.userId,
        displayName: a.displayName || a.userId,
        workerType: a.workerType ?? null,
        percent: pctOf(a.userId),
        ratePercent: fin?.ratePercent ?? 0,
        gross: fin?.grossAmount ?? 0,
        fee: fin?.feeAmount ?? 0,
        /** What they are paid — the make-whole figure, not the raw share. */
        net: fin?.amount ?? 0,
        /** The raw share before a W-2 top-up, and the top-up itself. */
        rawNet: fin?.netAmount ?? 0,
        topUp: fin?.topUpAmount ?? 0,
        promisedNet: pro?.net ?? 0,
        isEmployeeClass: payClass === "w2",
        payClass,
        /** True when this person has no pay class and cannot be priced. */
        unpriceable: cannotBePriced(a.workerType ?? null),
      };
    });

    // CLASS TOTALS COME FROM THE RECONCILER, not from re-summing the rows.
    // It reports the promised cuts rather than the actual-breakdown ones so
    // the card reconciles to its own stated total on an overpay — see the
    // note in reconcileApproval.
    const platformFeeTotal = outcome?.platformFeeAmount ?? 0;
    const businessMarginTotal = outcome?.businessMarginAmount ?? 0;
    const totalPayout = round2(rows.reduce((s, r) => s + r.net, 0));
    const totalTopUp = round2(rows.reduce((s, r) => s + r.topUp, 0));
    const N = validAmount ? round2(Math.max(0, amt - totalInvoiceCharges)) : 0;

    return {
      rows,
      platformFeeTotal,
      businessMarginTotal,
      totalPayout,
      totalTopUp,
      shortfall: outcome?.shortfallAmount ?? 0,
      overage: outcome?.overageAmount ?? 0,
      // Kept for the summary card, which states what the crew pool was.
      unallocated: round2(
        rows.filter((r) => r.unpriceable).reduce((s, r) => s + N * (r.percent / 100), 0),
      ),
      unpriceableNames: unpriceable.map((a) => a.displayName || a.userId),
      validAmount,
      N,
    };
  }, [
    amountPaid,
    assignees,
    splits,
    totalInvoiceCharges,
    commissionPercent,
    marginPercent,
    basePrice,
    addonsTotal,
    materialChargesTotal,
  ]);

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
  async function handleRequestPayment() {
    dlgErr.clear();
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
          dlgErr.setError(getErrorMessage("Failed to save splits.", err));
        })
        .finally(() => setRequestBusy(false));
      return;
    }
    // The service layer already filtered handoff.contacts to the primary
    // contact only. If empty, the client has no primary set — surface that
    // explicitly so a caller with `money.approve` can fix the data invariant.
    if (handoff.missingPrimaryContact || handoff.contacts.length === 0) {
      dlgErr.setError(
        "No primary contact set for this client. Open the client's contacts and mark one as Primary before requesting payment.",
      );
      return;
    }
    const primaryContact = handoff.contacts[0];
    const phoneContact = primaryContact.phone ? primaryContact : null;
    const emailContact = primaryContact.email ? primaryContact : null;
    if (!phoneContact && !emailContact) {
      dlgErr.setError(
        "Primary contact has no phone or email on file. Update their contact info before requesting payment.",
      );
      return;
    }
    const useSms = !!phoneContact?.phone;
    // Pull the current OUTGOING_COMMS_CC setting at click time so the URL
    // can't be stale relative to whatever was most recently saved.
    const cc = await fetchCommsCc();
    const href = useSms
      ? buildSmsHref({ to: phoneContact!.phone!, body: handoff.smsBody, ccPhones: cc.phones })
      : buildMailtoHref({ to: emailContact!.email!, subject: handoff.emailSubject, body: handoff.emailBody, ccEmails: cc.emails });
    // Open the device handler in the user gesture, then audit + close.
    window.location.href = href;
    setRequestBusy(true);
    apiPost(`/api/occurrences/${occurrenceId}/comms-handoff`, {
      channel: useSms ? "sms" : "email",
      completionSplits: splitsPayload,
    })
      .then(() => {
        publishInlineMessage({ type: "SUCCESS", text: "Payment request sent." });
        // New outstanding request — bump so the alerts dropdown's
        // "Payments to review" counter picks it up immediately.
        bumpPayments();
        onOpenChange(false);
        onAccepted({ requestSent: true });
      })
      .catch((err) => {
        dlgErr.setError(getErrorMessage("Failed to record request.", err));
      })
      .finally(() => setRequestBusy(false));
  }

  // Called by the Accept Now confirm dialog with the (possibly-adjusted)
  // actual amount received. The Amount Paid field on the main dialog stays
  // locked to the invoice total; this is the single override point.
  async function handleAcceptConfirmed(amountReceived: number) {
    dlgErr.clear();
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
      // Worker accept-payment lands the row in the approval queue; the
      // next-occurrence chain only advances at admin approval (see
      // services/payments.ts:approvePayment), so there's nothing to
      // report about a scheduled next visit yet — that surfaces on the
      // approval toast instead. Same "Payment {verb}." shape as every
      // other payment toast for consistency.
      publishInlineMessage({
        type: "INFO",
        text: composePaymentMessage(
          "submitted for approval",
          null,
          "The job stays in Pending Payment until it is verified. The next occurrence (if any) will be scheduled at approval time.",
        ),
      });
      // New Payment row in PENDING_APPROVAL state — bump so the alerts
      // dropdown's "Payments to review" counter picks it up across any
      // management tab the operator currently has open.
      bumpPayments();
      onOpenChange(false);
      onAccepted(result);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Accept payment failed.", err));
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
                  <ImpersonationWarning viewAsName={viewAsName} />
                  <VStack align="stretch" gap={3}>
                    <Box
                      p={3}
                      bg="blue.faint"
                      borderWidth="1px"
                      borderColor="blue.emphasized"
                      borderLeftWidth="4px"
                      borderLeftColor="blue.500"
                      rounded="md"
                    >
                      <Text fontSize="sm" color="blue.fg">
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
                      {/* Admin Jobs tab only: widen the picker to every active
                          method so a payment the client made remotely (e.g. an
                          unprompted Venmo) can be recorded on their behalf. */}
                      {allowAllMethods && !showAllMethods && (
                        <Text
                          mt={1}
                          fontSize="xs"
                          color="blue.fg"
                          cursor="pointer"
                          textDecoration="underline"
                          textDecorationStyle="dotted"
                          onClick={() => setShowAllMethods(true)}
                        >
                          Client paid another way? Show all payment methods
                        </Text>
                      )}
                      {allowAllMethods && showAllMethods && (
                        <Text
                          mt={1}
                          fontSize="xs"
                          color="fg.muted"
                          cursor="pointer"
                          textDecoration="underline"
                          textDecorationStyle="dotted"
                          onClick={() => {
                            setShowAllMethods(false);
                            // Drop a selection that's no longer in the narrowed list.
                            if (method[0] && !paymentMethods.some((m) => m.active && m.supportsOnSite && m.key === method[0])) {
                              setMethod([]);
                            }
                          }}
                        >
                          Showing all methods — back to on-site only
                        </Text>
                      )}
                    </div>
                    {/* Live processor-fee preview. Hidden entirely for zero-
                        fee methods (Cash, Check, Zelle as configured). For
                        fee-bearing methods, shows gross / fee / net so the
                        worker can see exactly what hits the bank account. */}
                    {selectedMethodConfig && liveFee.fee > 0 && (
                      <Box p={2} bg="orange.faint" rounded="md" borderWidth="1px" borderColor="orange.emphasized">
                        <VStack align="stretch" gap={0.5} fontSize="xs">
                          <HStack justify="space-between">
                            <Text color="fg.muted">Gross charged:</Text>
                            <Text fontWeight="medium">${liveFee.gross.toFixed(2)}</Text>
                          </HStack>
                          <HStack justify="space-between">
                            <Text color="orange.fg">
                              {selectedMethodConfig.label} fee
                              {selectedMethodConfig.feePercent > 0
                                ? ` (${selectedMethodConfig.feePercent}%${selectedMethodConfig.feeFixed > 0 ? ` + $${selectedMethodConfig.feeFixed.toFixed(2)}` : ""})`
                                : selectedMethodConfig.feeFixed > 0
                                  ? ` ($${selectedMethodConfig.feeFixed.toFixed(2)})`
                                  : ""}:
                            </Text>
                            <Text color="orange.fg" fontWeight="medium">−${liveFee.fee.toFixed(2)}</Text>
                          </HStack>
                          <HStack justify="space-between" borderTopWidth="1px" borderColor="orange.emphasized" pt={0.5} mt={0.5}>
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
                <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
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
                        dlgErr.clear();
                        const parsed = Number.parseFloat((confirmAmount ?? "").trim());
                        if (!Number.isFinite(parsed) || parsed < 0) {
                          dlgErr.setError("Enter a valid amount.");
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
                  <ImpersonationWarning viewAsName={viewAsName} />
                  <VStack align="stretch" gap={3}>
                    {(() => {
                      const missingPrimary =
                        !!handoff?.missingPrimaryContact || (handoff?.contacts.length ?? 0) === 0;
                      const primaryContact = handoff?.contacts[0] ?? null;
                      const phoneContact = primaryContact?.phone ? primaryContact : null;
                      const emailContact = primaryContact?.email ? primaryContact : null;
                      const channel: "sms" | "email" | "server" | "none" | "missing-primary" =
                        handoff?.mode === "SERVER"
                          ? "server"
                          : missingPrimary
                            ? "missing-primary"
                            : phoneContact?.phone
                              ? "sms"
                              : emailContact?.email
                                ? "email"
                                : "none";
                      return (
                        <>
                          <Box
                            p={3}
                            bg={channel === "missing-primary" ? "red.faint" : "blue.faint"}
                            borderWidth="1px"
                            borderColor={channel === "missing-primary" ? "red.emphasized" : "blue.emphasized"}
                            borderLeftWidth="4px"
                            borderLeftColor={channel === "missing-primary" ? "red.500" : "blue.500"}
                            rounded="md"
                          >
                            <Text fontSize="sm" color={channel === "missing-primary" ? "red.fg" : "blue.fg"}>
                              {channel === "server" && (
                                <>The payment request was already sent. Confirming will save the per-worker splits. Once the client indicates payment, someone with payment authority will review before the job is closed.</>
                              )}
                              {channel === "sms" && (
                                <>Your text app will open with a pre-filled message. Send it from there. Once the client indicates payment, someone with payment authority will review before the job is closed.</>
                              )}
                              {channel === "email" && (
                                <>Your email app will open with a pre-filled message. Send it from there. Once the client indicates payment, someone with payment authority will review before the job is closed.</>
                              )}
                              {channel === "missing-primary" && (
                                <>This client has no primary contact set. Open the client's contacts and mark one as Primary before requesting payment.</>
                              )}
                              {channel === "none" && (
                                <Text color="red.fg">
                                  The primary contact has no phone or email on file. Update their contact info before requesting payment.
                                </Text>
                              )}
                            </Text>
                          </Box>
                          <Box p={3} bg="gray.faint" rounded="md" borderWidth="1px" borderColor="gray.emphasized">
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
                <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
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
                      onClick={() => void handleRequestPayment()}
                      loading={requestBusy}
                      disabled={
                        !handoff ||
                        (() => {
                          if (handoff?.mode === "SERVER") return false;
                          if (handoff?.missingPrimaryContact) return true;
                          const primary = handoff?.contacts[0];
                          if (!primary) return true;
                          return !primary.phone && !primary.email;
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
                  bg="blue.faint"
                  borderWidth="1px"
                  borderColor="blue.emphasized"
                  borderLeftWidth="4px"
                  borderLeftColor="blue.500"
                  rounded="md"
                >
                  <Text fontSize="sm" color="blue.fg">
                    <Text as="span" fontWeight="semibold">Request Payment</Text> sends the client a message with a link to pay the invoice.{" "}
                    <Text as="span" fontWeight="semibold">Accept Now</Text> records a direct payment (e.g. cash on-site).
                    Either way the payment will be reviewed by someone with payment authority before the job closes.
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
                  // Work PLUS materials. This was `basePrice + addonsTotal`
                  // — the crew pool wearing the invoice's name — so a visit
                  // with materials displayed, and defaulted to collecting,
                  // less than the client was actually billed.
                  const invoiceTotal = (basePrice ?? 0) + addonsTotal + materialChargesTotal;
                  const differs = Math.abs(enteredAmount - invoiceTotal) > 0.01 && enteredAmount > 0;
                  return (
                    <Box p={3} bg="gray.faint" rounded="md" borderWidth="1px" borderColor="gray.emphasized">
                      <VStack align="stretch" gap={0.5} fontSize="xs">
                        <HStack justify="space-between" color="fg.muted">
                          <Text>Base price</Text>
                          <Text>${(basePrice ?? 0).toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color={addonsTotal > 0 ? "green.fg" : "fg.muted"}>
                          <Text>+ Add-ons</Text>
                          <Text>${addonsTotal.toFixed(2)}</Text>
                        </HStack>
                        {materialChargesTotal > 0 && (
                          <HStack justify="space-between" color="fg.muted">
                            <Text>+ Materials</Text>
                            <Text>${materialChargesTotal.toFixed(2)}</Text>
                          </HStack>
                        )}
                        <HStack justify="space-between" color="fg.muted">
                          <Text>= Invoice</Text>
                          <Text>${invoiceTotal.toFixed(2)}</Text>
                        </HStack>
                        <Box borderTopWidth="1px" borderColor="gray.emphasized" my={1} />
                        <HStack justify="space-between" fontWeight="semibold" color={differs ? "orange.fg" : undefined}>
                          <Text>Amount paid</Text>
                          <Text>${enteredAmount.toFixed(2)}</Text>
                        </HStack>
                        {differs && (
                          <Text fontSize="2xs" color="orange.fg" textAlign="right">
                            ({enteredAmount > invoiceTotal ? "over" : "under"} invoice by ${Math.abs(enteredAmount - invoiceTotal).toFixed(2)})
                          </Text>
                        )}
                        <HStack justify="space-between" color={totalInvoiceCharges > 0 ? "orange.fg" : "fg.muted"}>
                          <Text>− Invoice charges</Text>
                          <Text>${totalInvoiceCharges.toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color={breakdown.platformFeeTotal > 0 ? "orange.fg" : "fg.muted"}>
                          <Text>− Platform fee ({commissionPercent}% of contractor shares)</Text>
                          <Text>${breakdown.platformFeeTotal.toFixed(2)}</Text>
                        </HStack>
                        <HStack justify="space-between" color={breakdown.businessMarginTotal > 0 ? "orange.fg" : "fg.muted"}>
                          <Text>− Business margin ({marginPercent}% of employee shares)</Text>
                          <Text>${breakdown.businessMarginTotal.toFixed(2)}</Text>
                        </HStack>
                        <Box borderTopWidth="1px" borderColor="gray.emphasized" my={1} />
                        {/* THE MAKE-WHOLE LINE, which the old preview did not
                            have at all. On an underpay a W-2 worker is still
                            paid their promised net and the business covers
                            the gap — so "Workers receive" can exceed what
                            the arithmetic above it leaves, and without this
                            line the card would not reconcile to itself. */}
                        {breakdown.totalTopUp > 0 && (
                          <HStack justify="space-between" color="blue.fg">
                            <Text>+ Employee top-up (business covers)</Text>
                            <Text>${breakdown.totalTopUp.toFixed(2)}</Text>
                          </HStack>
                        )}
                        <HStack justify="space-between" fontWeight="bold">
                          <Text>Workers receive</Text>
                          <Text color="green.fg">${breakdown.totalPayout.toFixed(2)}</Text>
                        </HStack>
                        {breakdown.totalTopUp > 0 && (
                          <Text fontSize="2xs" color="blue.fg">
                            Paid short, so employees are made whole to what they
                            were promised and the shortfall comes off the
                            business&rsquo;s side. Contractors take their share of
                            what actually came in.
                          </Text>
                        )}
                        {/* SOMEBODY THE PAYOUT CANNOT PRICE. The server refuses
                            this payment rather than guess a rate, so saying so
                            here beats a successful-looking preview followed by
                            a failure on submit. */}
                        {breakdown.unpriceableNames.length > 0 && (
                          <Text fontSize="2xs" color="red.fg">
                            {breakdown.unpriceableNames.join(", ")}{" "}
                            {breakdown.unpriceableNames.length === 1 ? "has" : "have"} no
                            pay class, so this payment cannot be priced. Set a worker
                            type on {breakdown.unpriceableNames.length === 1 ? "them" : "them"}{" "}
                            or take {breakdown.unpriceableNames.length === 1 ? "them" : "them"} off
                            the visit first.
                          </Text>
                        )}
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
                                  colorPalette={r.payClass === "w2" ? "blue" : r.payClass === null ? "gray" : "purple"}
                                >
                                  {payClassLabel(r.workerType)}
                                </Badge>
                              )}
                            </HStack>
                            {breakdown.validAmount && r.percent > 0 && (
                              <Text fontSize="xs" color="fg.muted">
                                ${r.gross.toFixed(2)} gross
                                {/* worker-class-allow: naming an already-resolved payClass, not choosing a rate. */}
                                {r.fee > 0 && <> − ${r.fee.toFixed(2)} {r.payClass === "w2" ? "margin" : "fee"} ({r.ratePercent}%)</>}
                                {" = "}
                                <Text as="span" color="green.fg" fontWeight="semibold">${r.net.toFixed(2)}</Text>
                                {/* The share they earned on what came in, and
                                    the top-up that takes them to the promise.
                                    Shown per row because "why is Ana getting
                                    more than her percentage" is asked of the
                                    row, not the summary. */}
                                {r.topUp > 0 && (
                                  <Text as="span" color="blue.fg">
                                    {" "}(incl. ${r.topUp.toFixed(2)} top-up to the ${r.promisedNet.toFixed(2)} promised)
                                  </Text>
                                )}
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
                      borderColor="gray.emphasized"
                    >
                      <Text fontSize="xs" color={percentSum !== 100 ? "red.fg" : "fg.muted"}>
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

            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
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
                {occurrenceId && canRequestPayment && (
                  <Button
                    variant="solid"
                    colorPalette="green"
                    onClick={() => setView("confirm-request")}
                    loading={requestBusy}
                    disabled={
                      busy ||
                      !handoff ||
                      !splitsValid ||
                      !amountPaid ||
                      (() => {
                        const amt = parseFloat(amountPaid);
                        return isNaN(amt) || amt <= 0;
                      })()
                    }
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
