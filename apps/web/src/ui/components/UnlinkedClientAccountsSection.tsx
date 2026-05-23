"use client";

// Admin re-link worklist for phantom client accounts.
//
// When a client signs up with a different email than what's on their
// ClientContact, /client/link's email-match auto-link fails silently — they
// have a Clerk account that isn't tied to any client record. This section
// surfaces those phantoms so an admin can manually link them to the right
// contact in a few taps. Mirrors the OutstandingRequestsSection pattern:
// renders nothing when the list is empty.

import { useCallback, useEffect, useMemo, useState } from "react";
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
  VStack,
} from "@chakra-ui/react";
import { RefreshCw, Link2, Search, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type UnlinkedUser = {
  id: string;
  clerkUserId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  createdAt: string;
};

type UnlinkedContact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  client: { id: string; displayName: string };
};

function userLabel(u: UnlinkedUser): string {
  return u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.clerkUserId.slice(-8);
}

function contactLabel(c: UnlinkedContact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.id.slice(-6);
}

function daysAgoLabel(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export default function UnlinkedClientAccountsSection() {
  const [users, setUsers] = useState<UnlinkedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerFor, setPickerFor] = useState<UnlinkedUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<UnlinkedUser[]>("/api/admin/clients/unlinked-accounts");
      setUsers(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load unlinked accounts.", err) });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (users.length === 0 && !loading) return null;

  return (
    <>
      <Card.Root
        variant="outline"
        borderColor="orange.300"
        borderLeftWidth="4px"
        borderLeftColor="orange.500"
        mb={3}
        position="relative"
      >
        {loading && users.length > 0 && (
          <>
            <Box position="absolute" inset="0" bg="bg/80" zIndex="1" borderRadius="md" />
            <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
          </>
        )}
        <Card.Body p={3}>
          <HStack mb={1} justify="space-between">
            <HStack gap={2}>
              <Text fontSize="sm" fontWeight="semibold">Unlinked client accounts</Text>
              <Badge size="sm" colorPalette="orange" variant="solid" px="2" borderRadius="full">
                {users.length}
              </Badge>
            </HStack>
            <Button size="xs" variant="ghost" onClick={() => void load()} loading={loading}>
              <RefreshCw size={12} />
            </Button>
          </HStack>
          <Text fontSize="xs" color="fg.muted" mb={2}>
            These people signed in, but their Clerk email didn't match any client contact on file. Link each one to the right contact so they see their service history.
          </Text>
          <VStack align="stretch" gap={2}>
            {users.map((u) => (
              <HStack
                key={u.clerkUserId}
                justify="space-between"
                align="start"
                gap={2}
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                p={2}
              >
                <VStack align="start" gap={0.5} minW={0} flex={1}>
                  <Text fontSize="sm" fontWeight="medium">{userLabel(u)}</Text>
                  {u.email && (
                    <Text fontSize="xs" color="fg.muted">{u.email}</Text>
                  )}
                  <Text fontSize="xs" color="fg.muted">Signed up {daysAgoLabel(u.createdAt)}</Text>
                </VStack>
                <Button
                  size="xs"
                  colorPalette="orange"
                  onClick={() => setPickerFor(u)}
                >
                  <Link2 size={12} /> Link to contact
                </Button>
              </HStack>
            ))}
          </VStack>
        </Card.Body>
      </Card.Root>

      {pickerFor && (
        <ContactPickerDialog
          user={pickerFor}
          onClose={() => setPickerFor(null)}
          onLinked={() => {
            setPickerFor(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function ContactPickerDialog({
  user,
  onClose,
  onLinked,
}: {
  user: UnlinkedUser;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [contacts, setContacts] = useState<UnlinkedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [confirmContact, setConfirmContact] = useState<UnlinkedContact | null>(null);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    setLoading(true);
    const qs = user.email ? `?nearEmail=${encodeURIComponent(user.email)}` : "";
    apiGet<UnlinkedContact[]>(`/api/admin/client-contacts/unlinked${qs}`)
      .then((list) => setContacts(Array.isArray(list) ? list : []))
      .catch((err) => {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load contacts.", err) });
        setContacts([]);
      })
      .finally(() => setLoading(false));
  }, [user.clerkUserId, user.email]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const haystack = [
        contactLabel(c),
        c.email ?? "",
        c.phone ?? "",
        c.client.displayName,
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [contacts, search]);

  async function performLink(c: UnlinkedContact) {
    setLinking(true);
    try {
      await apiPost(`/api/admin/client-contacts/${c.id}/link-clerk`, {
        clerkUserId: user.clerkUserId,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Linked ${user.email ?? userLabel(user)} to ${contactLabel(c)} (${c.client.displayName}).`,
      });
      setConfirmContact(null);
      onLinked();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to link account.", err) });
    } finally {
      setLinking(false);
    }
  }

  return (
    <>
      <Dialog.Root open={true} onOpenChange={(e) => { if (!e.open) onClose(); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Link to a client contact</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md">
                    <Text fontSize="xs" color="orange.800">
                      Clerk account: <Text as="span" fontWeight="semibold">{user.email ?? userLabel(user)}</Text>
                      {user.email && userLabel(user) !== user.email && (
                        <> · {userLabel(user)}</>
                      )}
                    </Text>
                  </Box>
                  <HStack gap={2}>
                    <Search size={14} />
                    <Input
                      size="sm"
                      placeholder="Search…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </HStack>
                  {loading ? (
                    <Spinner size="sm" />
                  ) : filtered.length === 0 ? (
                    <Text fontSize="sm" color="fg.muted">
                      No unlinked contacts match. (Existing contacts are pre-sorted by email similarity.)
                    </Text>
                  ) : (
                    <VStack align="stretch" gap={1} maxH="60vh" overflowY="auto">
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
                              {contactLabel(c)} <Text as="span" color="fg.muted">· {c.client.displayName}</Text>
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              {c.email ?? "no email"}{c.phone ? ` · ${c.phone}` : ""}
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
                  <Button variant="ghost" onClick={onClose}>
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
        title="Link this account?"
        message={
          confirmContact
            ? `Link ${user.email ?? userLabel(user)} to ${contactLabel(confirmContact)} (${confirmContact.client.displayName})? They'll immediately see this client's properties and service history.`
            : ""
        }
        confirmLabel="Link"
        confirmColorPalette="orange"
        onConfirm={async () => {
          const c = confirmContact;
          if (c && !linking) await performLink(c);
        }}
        onCancel={() => setConfirmContact(null)}
      />
    </>
  );
}
