"use client";

// Per-contact Clerk-link controls used on the admin Clients tab. Shows either:
//   - a green "Linked" chip with an unlink (✕) action (when contact.clerkUserId
//     is set), or
//   - an "Link Clerk account" button that opens a picker of phantom Clerk
//     accounts (`/admin/clients/unlinked-accounts`), pre-sorted by email
//     similarity to this contact's email.
//
// Both paths go through ConfirmDialog so accidental taps on a mobile screen
// don't silently flip a real account's link state.

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
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
import { Link2, Search, Unlink2, X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type ContactInfo = {
  id: string;
  clerkUserId?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

type ClerkUser = {
  id: string;
  clerkUserId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  createdAt: string;
};

function clerkUserLabel(u: ClerkUser): string {
  return u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.clerkUserId.slice(-8);
}

export default function ClientContactLinkActions({
  contact,
  onChanged,
}: {
  contact: ContactInfo;
  onChanged?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [busy, setBusy] = useState(false);

  async function performUnlink() {
    setBusy(true);
    try {
      await apiDelete(`/api/admin/client-contacts/${contact.id}/link-clerk`);
      publishInlineMessage({ type: "SUCCESS", text: "Clerk account unlinked." });
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to unlink.", err) });
    } finally {
      setBusy(false);
      setConfirmUnlink(false);
    }
  }

  if (contact.clerkUserId) {
    return (
      <>
        <HStack gap={1} flexShrink={0}>
          <Badge size="sm" colorPalette="green" variant="subtle" title="Linked to a Clerk account">
            <HStack gap={1}>
              <Link2 size={10} />
              <Text>Linked</Text>
            </HStack>
          </Badge>
          <Button
            size="xs"
            variant="ghost"
            colorPalette="red"
            px={1}
            minW="0"
            disabled={busy}
            title="Unlink this Clerk account"
            onClick={() => setConfirmUnlink(true)}
          >
            <Unlink2 size={12} />
          </Button>
        </HStack>
        <ConfirmDialog
          open={confirmUnlink}
          title="Unlink Clerk account?"
          message="The client will no longer be able to see this client's properties or history from their portal. You can re-link them later from the Unlinked client accounts worklist."
          confirmLabel="Unlink"
          confirmColorPalette="red"
          onConfirm={performUnlink}
          onCancel={() => setConfirmUnlink(false)}
        />
      </>
    );
  }

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        colorPalette="orange"
        flexShrink={0}
        onClick={() => setPickerOpen(true)}
      >
        <Link2 size={12} /> Link Clerk
      </Button>
      {pickerOpen && (
        <ClerkUserPickerDialog
          contact={contact}
          onClose={() => setPickerOpen(false)}
          onLinked={() => {
            setPickerOpen(false);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

function ClerkUserPickerDialog({
  contact,
  onClose,
  onLinked,
}: {
  contact: ContactInfo;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [users, setUsers] = useState<ClerkUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [confirmUser, setConfirmUser] = useState<ClerkUser | null>(null);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    setLoading(true);
    const qs = contact.email ? `?nearEmail=${encodeURIComponent(contact.email)}` : "";
    apiGet<ClerkUser[]>(`/api/admin/clients/unlinked-accounts${qs}`)
      .then((list) => setUsers(Array.isArray(list) ? list : []))
      .catch((err) => {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load Clerk accounts.", err) });
        setUsers([]);
      })
      .finally(() => setLoading(false));
  }, [contact.id, contact.email]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const haystack = [clerkUserLabel(u), u.email ?? "", u.clerkUserId].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [users, search]);

  async function performLink(u: ClerkUser) {
    setLinking(true);
    try {
      await apiPost(`/api/admin/client-contacts/${contact.id}/link-clerk`, {
        clerkUserId: u.clerkUserId,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Linked ${u.email ?? clerkUserLabel(u)} to ${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "this contact"}.`,
      });
      setConfirmUser(null);
      onLinked();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to link account.", err) });
    } finally {
      setLinking(false);
    }
  }

  const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "this contact";

  return (
    <>
      <Dialog.Root open={true} onOpenChange={(e) => { if (!e.open) onClose(); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Link a Clerk account</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md">
                    <Text fontSize="xs" color="orange.800">
                      Contact: <Text as="span" fontWeight="semibold">{contactName}</Text>
                      {contact.email && (
                        <> · {contact.email}</>
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
                      No unlinked Clerk accounts {users.length === 0 ? "exist right now" : "match your search"}.
                    </Text>
                  ) : (
                    <VStack align="stretch" gap={1} maxH="60vh" overflowY="auto">
                      {filtered.map((u) => (
                        <HStack
                          key={u.clerkUserId}
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
                          onClick={() => setConfirmUser(u)}
                        >
                          <VStack align="start" gap={0} flex={1} minW={0}>
                            <Text fontSize="sm" fontWeight="medium">{clerkUserLabel(u)}</Text>
                            <Text fontSize="xs" color="fg.muted">
                              {u.email ?? "no email"}
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
        open={!!confirmUser}
        title="Link this Clerk account?"
        message={
          confirmUser
            ? `Link ${confirmUser.email ?? clerkUserLabel(confirmUser)} to ${contactName}? They'll immediately see this client's properties and service history.`
            : ""
        }
        confirmLabel="Link"
        confirmColorPalette="orange"
        onConfirm={async () => {
          if (confirmUser && !linking) await performLink(confirmUser);
        }}
        onCancel={() => setConfirmUser(null)}
      />
    </>
  );
}
