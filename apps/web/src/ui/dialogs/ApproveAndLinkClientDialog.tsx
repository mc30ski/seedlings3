"use client";

// Approval surface for a pending client sign-up that REQUIRES the operator
// to pick a ClientContact to bind to the Clerk identity, so the new user
// can never land in the "Unlinked client accounts" worklist as a phantom.
//
// Background: "Approve as Client" used to flip `User.isApproved = true`
// and nothing else; the link from Clerk → ClientContact was a separate
// step that often got skipped. This dialog folds both into one action —
// the server route runs the link inside the same transaction as the
// approval (see services/users.ts approve()), so partial-state failures
// are impossible. If the picker comes back empty (no unlinked contacts),
// the operator has to cancel, create the right contact in Admin → Clients
// first, then come back here.

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Link2, Search, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type UnlinkedContact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  client: { id: string; displayName: string };
};

type Props = {
  open: boolean;
  // The pending user we're approving. `email` is the Clerk email used to
  // sort the picker by email-local-part similarity AND to backfill the
  // contact's email field server-side when the contact has none on file.
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
  };
  onClose: () => void;
  onApproved: () => void;
};

function contactLabel(c: UnlinkedContact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.id.slice(-6);
}

function userLabel(u: Props["user"]): string {
  return u.displayName || u.email || u.id.slice(-8);
}

export default function ApproveAndLinkClientDialog({
  open,
  user,
  onClose,
  onApproved,
}: Props) {
  const [contacts, setContacts] = useState<UnlinkedContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [confirmContact, setConfirmContact] = useState<UnlinkedContact | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSearch("");
    setConfirmContact(null);
    const qs = user.email ? `?nearEmail=${encodeURIComponent(user.email)}` : "";
    apiGet<UnlinkedContact[]>(`/api/admin/client-contacts/unlinked${qs}`)
      .then((list) => setContacts(Array.isArray(list) ? list : []))
      .catch((err) => {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Failed to load contacts.", err),
        });
        setContacts([]);
      })
      .finally(() => setLoading(false));
  }, [open, user.email]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const haystack = [
        contactLabel(c),
        c.email ?? "",
        c.phone ?? "",
        c.client.displayName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [contacts, search]);

  async function performApproveAndLink(c: UnlinkedContact) {
    setSubmitting(true);
    try {
      await apiPost(`/api/admin/users/${user.id}/approve`, { linkContactId: c.id });
      try {
        window.dispatchEvent(new Event("seedlings3:users-changed"));
      } catch {}
      // When the contact had no email on file, the server backfills it
      // from the Clerk identity (see services/users.ts) — mention that
      // explicitly so the operator knows the contact card just gained
      // an email address.
      const willBackfillEmail = !c.email && !!user.email;
      publishInlineMessage({
        type: "SUCCESS",
        text: willBackfillEmail
          ? `Approved and linked to ${contactLabel(c)} (${c.client.displayName}). The contact's email was set to ${user.email}.`
          : `Approved and linked to ${contactLabel(c)} (${c.client.displayName}).`,
      });
      setConfirmContact(null);
      onApproved();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approve & link failed.", err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const willBackfillEmail = !!confirmContact && !confirmContact.email && !!user.email;

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(e) => {
          if (!e.open) onClose();
        }}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Approve as Client &amp; link to contact</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box
                    p={2}
                    bg="blue.50"
                    borderWidth="1px"
                    borderColor="blue.200"
                    borderRadius="md"
                  >
                    <Text fontSize="xs" color="blue.900">
                      Pick the ClientContact this Clerk account belongs to.
                      Approval and the contact link happen together so the
                      new user can&apos;t end up in the &quot;Unlinked client
                      accounts&quot; worklist as a phantom.
                    </Text>
                  </Box>
                  <Box
                    p={2}
                    bg="gray.50"
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="md"
                  >
                    <Text fontSize="xs" color="fg.muted">
                      Clerk account:{" "}
                      <Text as="span" fontWeight="semibold" color="fg.default">
                        {userLabel(user)}
                      </Text>
                      {user.email && userLabel(user) !== user.email && (
                        <> · {user.email}</>
                      )}
                    </Text>
                  </Box>
                  <HStack gap={2}>
                    <Search size={14} />
                    <Input
                      size="sm"
                      placeholder="Search by name, email, phone, or client…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </HStack>
                  {loading ? (
                    <HStack justify="center" py={4}>
                      <Spinner size="sm" />
                    </HStack>
                  ) : filtered.length === 0 ? (
                    <Box
                      p={3}
                      bg="orange.50"
                      borderWidth="1px"
                      borderColor="orange.300"
                      borderRadius="md"
                    >
                      <Text fontSize="sm" color="orange.900">
                        No unlinked contact matches.{" "}
                        {contacts.length === 0
                          ? "There are no unlinked ClientContacts on file."
                          : "Try clearing the search."}
                      </Text>
                      <Text fontSize="xs" color="orange.800" mt={1}>
                        If the contact doesn&apos;t exist yet, cancel and add
                        it from Admin → Directory → Clients first, then return
                        here to approve.
                      </Text>
                    </Box>
                  ) : (
                    <VStack align="stretch" gap={1} maxH="50vh" overflowY="auto">
                      {filtered.map((c) => (
                        <HStack
                          key={c.id}
                          as="button"
                          gap={2}
                          px={2}
                          py={1.5}
                          borderRadius="md"
                          borderWidth="1px"
                          borderColor="gray.200"
                          bg="white"
                          _hover={{ bg: "gray.50" }}
                          cursor="pointer"
                          textAlign="left"
                          onClick={() => setConfirmContact(c)}
                        >
                          <VStack align="start" gap={0} flex={1} minW={0}>
                            <Text fontSize="sm" fontWeight="medium">
                              {contactLabel(c)}{" "}
                              <Text as="span" color="fg.muted">
                                · {c.client.displayName}
                              </Text>
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              {c.email ?? "no email on file"}
                              {c.phone ? ` · ${c.phone}` : ""}
                            </Text>
                          </VStack>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={onClose} disabled={submitting}>
                    <X size={14} /> Cancel
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={!!confirmContact}
        title="Approve and link this account?"
        message={
          confirmContact
            ? `Approve ${userLabel(user)} as a Client and bind their Clerk identity to ${contactLabel(confirmContact)} (${confirmContact.client.displayName})? They'll immediately be able to sign in and see this client's properties and service history.`
            : ""
        }
        warning={
          willBackfillEmail
            ? `The contact has no email on file — linking will set it to ${user.email}.`
            : undefined
        }
        confirmLabel={submitting ? "Working…" : "Approve & link"}
        confirmColorPalette="green"
        onConfirm={async () => {
          const c = confirmContact;
          if (c && !submitting) await performApproveAndLink(c);
        }}
        onCancel={() => setConfirmContact(null)}
      />
    </>
  );
}

// Re-export the icon for consumers that want to mirror the in-dialog
// "Link to contact" affordance on the parent button. (UsersTab's
// "Approve as Client" button keeps its plain label; this export keeps
// the option open if the button is ever restyled.)
export const ApproveAndLinkIcon = Link2;
