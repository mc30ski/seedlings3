"use client";

// The client has already been told a number.
//
// `amountDue` on the payment link is computed LIVE from the occurrence, so
// anything that changes the job's total — a material charge, a service, a
// re-price — changes what the client sees when they open a link they were
// emailed days ago. They get told $150 and shown $350, with no explanation.
//
// Locking the amount at send time was the alternative. It trades a client
// surprise for an operator one ("why won't this update?") and adds a stored
// number that can drift from the job. Warning the operator at the moment they
// change it keeps a human in the loop instead, which is the only thing that
// actually prevents the surprise.
//
// Renders nothing when no request is outstanding, so every call site can
// mount it unconditionally.

import { Box, Text } from "@chakra-ui/react";

export function InvoiceAlreadySentNote({
  sentAmount,
  action = "Adding this",
}: {
  /** What the client was last asked to pay, or null when no request is in
   *  flight (nothing sent, or a payment already recorded). */
  sentAmount: number | null | undefined;
  /** How to describe the change in progress, e.g. "Changing the price". */
  action?: string;
}) {
  if (sentAmount == null) return null;
  return (
    <Box
      px={2.5}
      py={2}
      borderRadius="md"
      bg="orange.subtle"
      borderWidth="1px"
      borderLeftWidth="3px"
      borderColor="orange.solid"
    >
      <Text fontSize="13px" fontWeight="semibold">
        This client already has an invoice for ${sentAmount.toFixed(2)}
      </Text>
      <Text fontSize="12px" color="fg.muted">
        {action} changes what they owe. Their payment link updates immediately,
        so re-send the invoice from the job card — otherwise they open a link
        showing a different number from the one you sent them.
      </Text>
    </Box>
  );
}

/**
 * What the client was last asked to pay, or null when nothing is outstanding.
 *
 * Null once a Payment exists: at that point the amount is settled and the
 * re-price path refuses anyway.
 */
export function outstandingInvoiceAmount(
  occ: { paymentRequestSentAt?: string | null; payment?: unknown | null } | null | undefined,
  currentTotal: number | null,
): number | null {
  if (!occ || !occ.paymentRequestSentAt || occ.payment) return null;
  return currentTotal ?? 0;
}
