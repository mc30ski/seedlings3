"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
  Checkbox,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiPost, apiPatch } from "@/src/lib/api";
import {
  Role,
  DialogMode,
  Contact,
  ContactStatus,
  ContactKind,
  CONTACT_KIND,
  CONTACT_STATUS,
} from "@/src/lib/types";
import { prettyStatus } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  role: Role;
  initial?: Contact | null;
  onSaved?: (saved: any) => void;
  clientId: string;
  preventOutsideClose?: boolean;
};

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const E164 = /^\+?[1-9]\d{7,14}$/;

export default function ClientDialog({
  open,
  onOpenChange,
  mode,
  role,
  initial,
  onSaved,
  clientId,
  preventOutsideClose,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const isAdmin = role === "ADMIN";
  const [busy, setBusy] = useState(false);

  // --- Form state ---
  const [statusValue, setStatusValue] = useState<string[]>([CONTACT_STATUS[0]]);
  const [kindValue, setKindValue] = useState<string[]>([CONTACT_KIND[0]]);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);

  const statusItems = useMemo(
    () =>
      CONTACT_STATUS.map((s) => ({
        label: prettyStatus(s),
        value: s,
      })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  const kindItems = useMemo(
    () =>
      CONTACT_KIND.map((s) => ({
        label: prettyStatus(s),
        value: s,
      })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  const [showMissingWarning, setShowMissingWarning] = useState(false);

  function ableToSave() {
    return (
      statusValue &&
      kindValue &&
      firstName &&
      (!email || EMAIL_RE.test(email)) &&
      (!phone || E164.test(phone))
    );
  }

  function hasMissingInfo() {
    return !lastName.trim() || (!email.trim() && !phone.trim());
  }

  // seed form when opening/switching modes/records
  useEffect(() => {
    if (!open) return;
    if (mode === "UPDATE" && initial) {
      setKindValue([initial.role ?? CONTACT_KIND[0]]);
      setStatusValue([initial.status ?? CONTACT_STATUS[0]]);
      setFirstName(initial.firstName ?? "");
      setLastName(initial.lastName ?? "");
      setNickname(initial.nickname ?? "");
      setEmail(initial.email ?? "");
      setPhone(initial.phone ?? "");
      setIsPrimary(!!initial.isPrimary);
      setShowMissingWarning(false);
    } else {
      setKindValue([CONTACT_KIND[0]]);
      setStatusValue([CONTACT_STATUS[0]]);
      setFirstName("");
      setLastName("");
      setNickname("");
      setEmail("");
      setPhone("");
      setIsPrimary(false);
      setShowMissingWarning(false);
    }
  }, [open, mode, initial]);

  async function handleSave() {
    if (!firstName.trim()) {
      publishInlineMessage({
        type: "WARNING",
        text: "First name is required.",
      });
      return;
    }

    // Show warning if missing last name or contact info
    if (hasMissingInfo() && !showMissingWarning) {
      setShowMissingWarning(true);
      return;
    }
    setShowMissingWarning(false);

    const payload = {
      role: (kindValue[0] as ContactKind) ?? CONTACT_KIND[0],
      status: (statusValue[0] as ContactStatus) ?? CONTACT_STATUS[0],
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      nickname: nickname.trim() || null,
      email: email.trim(),
      phone: phone.trim(),
      isPrimary,
    };

    setBusy(true);
    try {
      let saved: Contact;
      if (mode === "CREATE") {
        saved = await apiPost<Contact>(
          `/api/admin/clients/${clientId}/contacts`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Contact '${payload.firstName} ${payload.lastName}' created.`,
        });
      } else {
        if (!initial?.id) throw new Error("Missing client id");
        saved = await apiPatch<Contact>(
          `/api/admin/clients/${clientId}/contacts/${initial.id}`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Contact '${payload.firstName} ${payload.lastName}' updated.`,
        });
      }
      onSaved?.(saved);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "CREATE" ? "Create contact failed" : "Update contact failed",
          err
        ),
      });
    } finally {
      onOpenChange(false);
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      closeOnInteractOutside={!preventOutsideClose}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            mx="4"
            maxW="lg"
            w="full"
            rounded="2xl"
            p="4"
            shadow="lg"
          >
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {mode === "CREATE" ? "Add Contact" : "Update Contact"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Status *</Text>
                    <Select.Root
                      collection={statusCollection}
                      value={statusValue}
                      onValueChange={(e) => setStatusValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                      disabled={!isAdmin && mode === "UPDATE"}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select status" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {statusItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Kind *</Text>
                    <Select.Root
                      collection={kindCollection}
                      value={kindValue}
                      onValueChange={(e) => setKindValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                      disabled={!isAdmin && mode === "UPDATE"}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select kind" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {kindItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>
                </HStack>
                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">First name</Text>
                    <Input
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="First name"
                      autoFocus
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Nickname</Text>
                    <Input
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      placeholder="Optional"
                    />
                  </div>
                </HStack>
                <div style={{ flex: 1 }}>
                  <Text mb="1">Last name</Text>
                  <Input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Last name"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Text mb="1">Email</Text>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Text mb="1">Phone</Text>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="15551234567"
                  />
                </div>
                <Checkbox.Root
                  checked={isPrimary}
                  onCheckedChange={(e) => setIsPrimary(!!e.checked)}
                  disabled={false}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>Primary point of contact</Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>
            {showMissingWarning && (
              <VStack align="stretch" px="4" pb="2" gap={1}>
                <Text fontSize="sm" color="orange.600" fontWeight="medium">
                  This contact is missing{" "}
                  {[
                    !lastName.trim() && "a last name",
                    !email.trim() && !phone.trim() && "an email or phone number",
                  ]
                    .filter(Boolean)
                    .join(" and ")}
                  . You can still save, but this should be updated later.
                </Text>
              </VStack>
            )}
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => { onOpenChange(false); setShowMissingWarning(false); }}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  loading={busy}
                  disabled={!ableToSave()}
                  colorPalette={showMissingWarning ? "orange" : undefined}
                >
                  {showMissingWarning ? "Save Anyway" : mode === "CREATE" ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
