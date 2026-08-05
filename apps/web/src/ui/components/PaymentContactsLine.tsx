"use client";

// Small display helper used by the Awaiting Payment (OutstandingRequestsSection)
// and Pending Approval (PendingApprovalsSection) cards. Renders every
// ACTIVE contact on the payment's client so the operator can match a
// spouse / roommate / different-last-name payer to the property when
// reconciling a Zelle/Venmo/bank record.
//
// Sorted primary-first upstream; this component doesn't sort.
// Nickname (if present) shown in parens after the full name.
// Phone + email surface as hover tooltip so scanning stays uncluttered.

import { Text } from "@chakra-ui/react";

export type PaymentContact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
};

function displayName(c: PaymentContact): string {
  const parts = [c.firstName, c.lastName].filter((s): s is string => !!s && s.trim().length > 0);
  const full = parts.join(" ").trim();
  const nick = c.nickname?.trim();
  if (full && nick) return `${full} (${nick})`;
  return full || nick || c.email || c.phone || "(unnamed)";
}

function tooltip(c: PaymentContact): string {
  const bits: string[] = [];
  if (c.isPrimary) bits.push("Primary");
  if (c.phone) bits.push(c.phone);
  if (c.email) bits.push(c.email);
  return bits.join(" · ");
}

export function PaymentContactsLine({ contacts }: { contacts: PaymentContact[] }) {
  if (contacts.length === 0) return null;
  return (
    <Text fontSize="xs" color="fg.muted">
      Contacts:{" "}
      {contacts.map((c, i) => (
        <Text as="span" key={c.id} title={tooltip(c)}>
          {i > 0 && ", "}
          <Text as="span" fontWeight={c.isPrimary ? "medium" : "normal"}>
            {displayName(c)}
          </Text>
        </Text>
      ))}
    </Text>
  );
}
