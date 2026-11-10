"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO MONEY CLOCKS ON AN UNPAID VISIT, drawn once for every screen.
//
// Money → Awaiting payment showed "Requested 3 days ago". Work → Repeating
// showed "Waiting 27 days". Same rows, two screens, two different numbers and
// no way to reconcile them without opening the job — because they answer
// DIFFERENT QUESTIONS and each screen had only half the answer:
//
//   Waiting   — how long the visit has been a receivable, measured from the
//               day the work was finished. The business's exposure.
//   Requested — how long the client has had the ask. Whose move it is.
//
// A visit finished 27 days ago and invoiced this morning is a completely
// different problem from one invoiced 27 days ago and ignored, and neither
// number alone separates them. So both screens now carry both, from one
// component, with the day counts from one rule (`lib/paymentWait.ts`).
//
// WHAT "THE SAME BADGE" MEANS HERE: same order, same wording, same size, same
// rule for which one goes loud. The HUE is the host's, and that is deliberate
// rather than an oversight — Money → Awaiting payment sits on a purple card
// where its own comment records that orange "read as a different feature
// dropped inside this one", and the Repeating row uses purple for "Held", so
// a purple money chip there would collide with the status language. One hue
// across both would have to break one of those two.
// ─────────────────────────────────────────────────────────────────────────────

import { Badge, HStack } from "@chakra-ui/react";

/** "Waiting 27 days" / "Finished today" — the receivable clock. */
export function waitingLabel(days: number): string {
  if (days <= 0) return "Finished today";
  if (days === 1) return "Waiting 1 day";
  return `Waiting ${days} days`;
}

/** "Requested 3 days ago" — the invoice clock. */
export function requestedLabel(days: number): string {
  if (days <= 0) return "Requested today";
  if (days === 1) return "Requested 1 day ago";
  return `Requested ${days} days ago`;
}

/** Same wording anchored on the ORIGINAL send. Only used once a request has
 *  been re-sent — otherwise `requestedLabel` already reads correctly. */
export function firstRequestedLabel(days: number): string {
  if (days <= 0) return "Originally requested today";
  if (days === 1) return "Originally requested 1 day ago";
  return `Originally requested ${days} days ago`;
}

/** Short "today / 1 day ago / 3 days ago" fragment for the re-send badge. */
export function agoFragment(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export type PaymentWaitShape = {
  waitingDays: number | null;
  requestedDays: number | null;
  firstRequestedDays: number | null;
  resendCount: number;
  neverRequested: boolean;
};

export default function PaymentWaitBadges({
  wait,
  palette,
  /** The loud rung. The host owns the threshold — Money reads its
   *  `PAYMENT_REQUEST_STALE_DAYS` setting, Repeating uses "this wait has
   *  already cost the stream a visit". */
  stale = false,
  size = "sm",
}: {
  wait: PaymentWaitShape;
  /** The host surface's own hue — see the note at the top of this file. */
  palette: string;
  stale?: boolean;
  size?: "sm" | "xs";
}) {
  const { waitingDays, requestedDays, firstRequestedDays, resendCount, neverRequested } = wait;
  return (
    <HStack gap={1.5} flexWrap="wrap">
      {/* WAITING FIRST, because it is the number that does not reset. A
          re-send moves "Requested" back to today while the visit has been
          unpaid for six weeks, and reading the resettable number first is
          what made a six-week-old receivable look fresh. */}
      {waitingDays !== null && (
        <Badge
          size={size}
          colorPalette={palette}
          variant={stale ? "solid" : "subtle"}
          title="How long since the work was finished. This clock does not reset when an invoice is re-sent."
          data-testid="payment-wait-waiting"
        >
          {waitingLabel(waitingDays)}
        </Badge>
      )}

      {/* NEVER ASKED IS ITS OWN STATE, not a missing number. "Asked, no
          answer" is the client's move; "never asked" is yours — and the
          second is invisible on Money → Awaiting payment, which can only
          list invoices that went out. */}
      {neverRequested ? (
        <Badge
          size={size}
          colorPalette="red"
          variant="subtle"
          title="No payment request has been sent for this visit yet."
          data-testid="payment-wait-never-requested"
        >
          Never requested
        </Badge>
      ) : (
        requestedDays !== null && (
          <Badge
            size={size}
            colorPalette={palette}
            variant="subtle"
            title={
              resendCount > 0 && firstRequestedDays !== null
                ? `${firstRequestedLabel(firstRequestedDays)}; latest re-send ${agoFragment(requestedDays)}.`
                : "When the payment request was last sent to the client."
            }
            data-testid="payment-wait-requested"
          >
            {requestedLabel(requestedDays)}
          </Badge>
        )
      )}

      {resendCount > 0 && requestedDays !== null && (
        <Badge
          size={size}
          colorPalette="blue"
          variant="subtle"
          title={`This request has been re-sent ${resendCount} time${
            resendCount === 1 ? "" : "s"
          } since the original send. Latest re-send: ${agoFragment(requestedDays)}.`}
          data-testid="payment-wait-resent"
        >
          Re-sent {resendCount}× · last {agoFragment(requestedDays)}
        </Badge>
      )}
    </HStack>
  );
}
