"use client";

// Request Payment shortcut on the job card.
//
// Three states (driven by whether a Payment row exists, whether a Request
// was already sent, and which DEFAULT_PAYMENT_COMMUNICATIONS_MODE applies):
//   - Open:        no Payment row, no request sent → just "Request Payment".
//   - In flight:   no Payment row, request was sent → "Re-send Request"
//                  plus a "Cancel Request" escape valve.
//   - Server mode: backend already sent the request → passive indicator
//                  ("Payment request sent by server"), no card buttons.
//
// The "Awaiting admin approval" state (Payment row exists, confirmed=false)
// is rendered by the parent card, not here.
//
// Tapping Request Payment (or Re-send) opens a ConfirmDialog with a blue
// info banner explaining the flow. The actual sms:/mailto: link fires
// only on confirm — so a stray tap doesn't open the device's SMS app.

import { useEffect, useState } from "react";
import { Button, HStack, Text } from "@chakra-ui/react";
import { MessageCircle, RotateCw, Send, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { buildMailtoHref, buildSmsHref, fetchCommsCc } from "@/src/lib/comms";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type HandoffContact = {
  id: string;
  firstName: string | null;
  phone: string | null;
  email: string | null;
};

type HandoffPayload = {
  mode: "SERVER" | "CLAIMER";
  token: string;
  url: string;
  amountDue: number;
  propertyLabel: string;
  smsBody: string;
  emailSubject: string;
  emailBody: string;
  contacts: HandoffContact[];
  missingPrimaryContact?: boolean;
};

export default function PaymentCommsButtons({
  occurrenceId,
  requestSentAt,
  variant = "solid",
  onRequestCanceled,
}: {
  occurrenceId: string;
  /** When set, the card is in the "request in flight" state — show
   *  Re-send + Cancel Request instead of plain Request Payment. */
  requestSentAt?: string | null;
  /** Visual variant. "solid" (default) on the job card where the button
   *  is a primary action; "outline" inside dialogs where a louder solid
   *  would compete with the dialog's own primary action. */
  variant?: "solid" | "outline";
  /** Fired after a successful Cancel Request OR after the worker
   *  commits a Request Payment / Re-send, so the parent can refresh
   *  the occurrence (paymentRequestSentAt rotates, token may change). */
  onRequestCanceled?: () => void;
}) {
  const [data, setData] = useState<HandoffPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<HandoffPayload>(`/api/occurrences/${occurrenceId}/comms-handoff`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { /* gracefully degrade — the row just won't show a button */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [occurrenceId]);

  if (loading) return null;
  if (!data) return null;

  if (data.missingPrimaryContact) {
    return (
      <Text fontSize="xs" color="red.700">
        No primary contact set for this client — open the client's contacts and mark one as Primary before sending the payment link.
      </Text>
    );
  }

  if (data.mode === "SERVER") {
    return (
      <HStack gap={1.5} fontSize="xs" color="fg.muted">
        <Send size={12} />
        <Text>Payment request sent by server</Text>
      </HStack>
    );
  }

  // CLAIMER mode — the primary contact is the only routing target. Phone
  // wins; email is the fallback. The service layer already filtered to the
  // primary, so data.contacts is at most one entry.
  const primaryContact = data.contacts[0] ?? null;
  const phoneContact = primaryContact?.phone ? primaryContact : null;
  const emailContact = primaryContact?.email ? primaryContact : null;

  if (!primaryContact) {
    return (
      <Text fontSize="xs" color="red.700">
        No primary contact set for this client — open the client's contacts and mark one as Primary before sending the payment link.
      </Text>
    );
  }
  if (!phoneContact && !emailContact) {
    return (
      <Text fontSize="xs" color="orange.700">
        Primary contact has no phone or email — update their contact info to send the payment link.
      </Text>
    );
  }

  // The channel is determined by what contact info is on file — phone
  // wins; email is the fallback.
  const useSms = !!phoneContact?.phone;

  async function commitRequest() {
    // Fetch the OUTGOING_COMMS_CC setting fresh at click time so the URL
    // can't be stale relative to whatever the admin most recently saved.
    const cc = await fetchCommsCc();
    const href = useSms
      ? buildSmsHref({ to: phoneContact!.phone!, body: data!.smsBody, ccPhones: cc.phones })
      : buildMailtoHref({ to: emailContact!.email!, subject: data!.emailSubject, body: data!.emailBody, ccEmails: cc.emails });
    window.location.href = href;
    apiPost(`/api/occurrences/${occurrenceId}/comms-handoff`, {
      channel: useSms ? "sms" : "email",
    })
      .then(() => onRequestCanceled?.())
      .catch((err) => {
        console.warn("Failed to record comms handoff:", err);
      });
  }

  async function handleCancel() {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/cancel-payment-request`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Request canceled. The old link will no longer work." });
      onRequestCanceled?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't cancel request.", err) });
    } finally {
      setBusy(false);
    }
  }

  const inFlight = !!requestSentAt;
  const requestLabel = inFlight ? "Re-send Request" : "Request Payment";
  const RequestIcon = inFlight ? RotateCw : MessageCircle;

  const confirmMessage = inFlight
    ? `Re-send the message with a link to pay the invoice. The previous link still works.`
    : `Send the client a message with a link to pay the invoice. Once sent, the job switches to "Request in flight" — you'll be able to Re-send or Cancel.`;

  return (
    <>
      <HStack gap={2} wrap="wrap">
        <Button
          size="sm"
          variant={variant}
          colorPalette="orange"
          onClick={() => setConfirmOpen(true)}
        >
          <RequestIcon size={12} /> {requestLabel}
        </Button>
        {inFlight && (
          <Button
            size="sm"
            variant="ghost"
            colorPalette="gray"
            loading={busy}
            onClick={() => void handleCancel()}
          >
            <X size={12} /> Cancel Request
          </Button>
        )}
      </HStack>
      <ConfirmDialog
        open={confirmOpen}
        title={inFlight ? "Re-send Payment Request?" : "Request Payment from Client?"}
        message=""
        warning={confirmMessage}
        confirmLabel={inFlight ? "Re-send" : "Send Request"}
        confirmColorPalette="orange"
        onConfirm={() => {
          setConfirmOpen(false);
          void commitRequest();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
