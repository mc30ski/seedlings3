"use client";

// Small display helper used by the Awaiting Payment (OutstandingRequestsSection)
// and Pending Approval (PendingApprovalsSection) cards. Renders the
// property's full street address as a secondary line so the operator can
// identify WHICH property when the primary label is a nickname like
// "Home" — the display name alone doesn't tell you which house.
//
// Rendered only when there's a distinct address to add (i.e., the address
// isn't already what the primary label shows).

import { Text } from "@chakra-ui/react";

export type PaymentProperty = {
  displayName: string | null;
  street1: string | null;
  city: string | null;
  state: string | null;
};

function formatAddress(p: PaymentProperty): string {
  return [p.street1, p.city, p.state].filter(Boolean).join(", ").trim();
}

export function PaymentPropertyLine({ property }: { property: PaymentProperty | null | undefined }) {
  if (!property) return null;
  const address = formatAddress(property);
  if (!address) return null;
  // Skip when the primary label already IS the address (no displayName).
  // In that case the address is redundant with the label above.
  if (!property.displayName) return null;
  return (
    <Text fontSize="xs" color="fg.muted">
      Property: {address}
    </Text>
  );
}
