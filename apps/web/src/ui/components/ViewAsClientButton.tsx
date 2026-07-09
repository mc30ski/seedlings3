"use client";

import { useState } from "react";
import { Badge, Box, Button, Dialog, HStack, Portal, Text, VStack } from "@chakra-ui/react";
import { Eye, X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { setClientImpersonation } from "@/src/lib/impersonation";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";

type ContactRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  isPrimary: boolean;
  hasClerkAccount: boolean;
};

/**
 * Super-only "View as this client" button. Shown on each client card in
 * the admin ClientsTab. On click, fetches the impersonatable contacts
 * for the client:
 *
 *  - Zero clerk-linked contacts → error toast, no dialog. Nothing to
 *    impersonate ("this client has never logged in").
 *  - Exactly one clerk-linked contact → skip the picker and enter the
 *    session immediately.
 *  - Two or more clerk-linked contacts → picker dialog, primary
 *    preselected and marked with a "Primary" chip. Non-clerk contacts
 *    listed but disabled with the reason inline.
 *
 * Entering the session persists the choice via setClientImpersonation
 * (which also forces topTab → "client") and hard-reloads the page so
 * every subsequent request carries the x-impersonate-client-contact
 * header.
 */
export default function ViewAsClientButton({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function fetchAndOpen() {
    setBusy(true);
    try {
      const data = await apiGet<{ contacts: ContactRow[] }>(
        `/api/admin/clients/${clientId}/impersonatable-contacts`,
      );
      const list = data.contacts ?? [];
      const clerkLinked = list.filter((c) => c.hasClerkAccount);

      if (clerkLinked.length === 0) {
        publishInlineMessage({
          type: "ERROR",
          text: `${clientName} has no contact with a login. Nothing to view as.`,
        });
        return;
      }
      if (clerkLinked.length === 1) {
        // Only one option — skip the picker.
        await enterImpersonation(clerkLinked[0]);
        return;
      }
      // Multiple — show the picker. Primary preselected.
      const primary = clerkLinked.find((c) => c.isPrimary) ?? clerkLinked[0];
      setSelectedId(primary.id);
      setContacts(list);
      setPickerOpen(true);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load contacts.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function enterImpersonation(contact: ContactRow) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
      contact.email ||
      "Unknown Contact";
    await setClientImpersonation({
      contactId: contact.id,
      contactName: name,
      clientName,
    });
    // setClientImpersonation reloads the page — no code past this point runs.
  }

  return (
    <>
      <Button
        data-testid="view-as-client-button"
        data-client-id={clientId}
        size="xs"
        variant="outline"
        colorPalette="purple"
        onClick={() => void fetchAndOpen()}
        loading={busy}
        title="View this client's portal as they would see it (read-only)"
      >
        <Eye size={12} /> View as
      </Button>

      {pickerOpen && (
        <ContactPickerDialog
          clientName={clientName}
          contacts={contacts}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCancel={() => setPickerOpen(false)}
          onConfirm={async () => {
            const contact = contacts.find((c) => c.id === selectedId);
            if (!contact || !contact.hasClerkAccount) return;
            await enterImpersonation(contact);
          }}
        />
      )}
    </>
  );
}

function ContactPickerDialog({
  clientName,
  contacts,
  selectedId,
  onSelect,
  onCancel,
  onConfirm,
}: {
  clientName: string;
  contacts: ContactRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onCancel(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>View as which contact?</Dialog.Title>
              <Text fontSize="xs" color="fg.muted" mt={0.5}>
                {clientName} — pick a contact whose portal you want to see.
              </Text>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={2}>
                {contacts.map((c) => {
                  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") ||
                    c.email ||
                    "Unnamed Contact";
                  const isSelected = c.id === selectedId;
                  const canPick = c.hasClerkAccount;
                  return (
                    <Box
                      key={c.id}
                      as="button"
                      p={3}
                      borderWidth="1px"
                      borderColor={isSelected ? "purple.400" : "gray.200"}
                      borderRadius="md"
                      bg={isSelected ? "purple.50" : canPick ? "white" : "gray.50"}
                      opacity={canPick ? 1 : 0.55}
                      cursor={canPick ? "pointer" : "not-allowed"}
                      onClick={() => canPick && onSelect(c.id)}
                      textAlign="left"
                      _hover={canPick ? { borderColor: "purple.300" } : {}}
                    >
                      <HStack gap={2} align="start" wrap="wrap">
                        <VStack align="start" gap={0.5} flex="1" minW={0}>
                          <HStack gap={2} wrap="wrap">
                            <Text fontSize="sm" fontWeight="medium">
                              {name}
                            </Text>
                            {c.isPrimary && (
                              <Badge size="xs" colorPalette="purple" variant="solid">
                                Primary
                              </Badge>
                            )}
                            {c.role && (
                              <Badge size="xs" colorPalette="gray" variant="outline">
                                {c.role}
                              </Badge>
                            )}
                          </HStack>
                          {c.email && (
                            <Text fontSize="xs" color="fg.muted">
                              {c.email}
                            </Text>
                          )}
                          {!canPick && (
                            <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                              Never logged in — no account to view as.
                            </Text>
                          )}
                        </VStack>
                      </HStack>
                    </Box>
                  );
                })}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onCancel}>
                  <X size={14} /> Cancel
                </Button>
                <Button
                  colorPalette="purple"
                  onClick={onConfirm}
                  disabled={!selectedId || !contacts.find((c) => c.id === selectedId)?.hasClerkAccount}
                >
                  <Eye size={14} /> Enter as this contact
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
