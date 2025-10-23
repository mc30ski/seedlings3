"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
  Switch,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiPost, apiPatch } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Mode = "create" | "update";

// If your enum differs, adjust these to match your Prisma `ContactRole`
const CONTACT_ROLE_ITEMS = [
  { label: "Unspecified", value: "UNSPECIFIED" }, // we'll omit from payload if chosen
  { label: "SPOUSE", value: "SPOUSE" },
  { label: "COMMUNITY_MANAGER", value: "COMMUNITY_MANAGER" },
  { label: "PROPERTY_MANAGER", value: "PROPERTY_MANAGER" },
  //TODO:
  /*
  { label: "BILLING", value: "BILLING" },
  { label: "TECHNICAL", value: "TECHNICAL" },
  { label: "OPERATIONS", value: "OPERATIONS" },
  { label: "LEGAL", value: "LEGAL" },
  { label: "OTHER", value: "OTHER" },
*/
];

/* TODO:
export type Contact = {
  id: string;
  clientId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
  active?: boolean;
  contactPriority?: number | null;
};
*/

export type Contact = {
  id: string;
  clientId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
  active?: boolean;
  contactPriority?: number | null;
  //TODO:
  //preferredName?: string | null;
  //normalizedPhone?: string | null;
  //isBilling?: boolean;

  createdAt?: string | null;
  updatedAt?: string | null;
  //TODO: Doesn't exist in schema
  //archivedAt?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  mode: Mode;

  /** Required: The parent client id */
  clientId: string;

  /** For update mode */
  initialContact?: Contact | null;

  /** InlineMessage scope; mount <InlineMessage scope="clients" /> */
  scope?: string;

  /** Called after successful save with the server payload */
  onSaved?: (saved: any) => void;

  /** Optional primary button label override */
  actionLabel?: string;
};

export default function ContactDialog({
  open,
  onOpenChange,
  mode,
  clientId,
  initialContact,
  scope = "clients",
  onSaved,
  actionLabel,
}: Props) {
  const [busy, setBusy] = useState(false);

  // --- Form state ---
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [active, setActive] = useState(true);
  const [contactPriority, setContactPriority] = useState<number | "">("");

  // role select
  const [roleValue, setRoleValue] = useState<string[]>(["UNSPECIFIED"]);
  const roleCollection = useMemo(
    () => createListCollection({ items: CONTACT_ROLE_ITEMS }),
    []
  );

  // Seed/reset
  useEffect(() => {
    if (!open) return;
    if (mode === "update" && initialContact) {
      setFirstName(initialContact.firstName ?? "");
      setLastName(initialContact.lastName ?? "");
      setEmail(initialContact.email ?? "");
      setPhone(initialContact.phone ?? "");
      setIsPrimary(!!initialContact.isPrimary);
      setActive(initialContact.active ?? true);
      setContactPriority(
        typeof initialContact.contactPriority === "number"
          ? initialContact.contactPriority
          : ""
      );
      setRoleValue([initialContact.role ?? "UNSPECIFIED"]);
    } else {
      setFirstName("");
      setLastName("");
      setEmail("");
      setPhone("");
      setIsPrimary(false);
      setActive(true);
      setContactPriority("");
      setRoleValue(["UNSPECIFIED"]);
    }
  }, [open, mode, initialContact]);

  async function handleSave() {
    if (!firstName.trim() && !lastName.trim()) {
      publishInlineMessage({
        scope,
        type: "WARNING",
        text: "Enter at least a first or last name for the contact.",
        autoHideMs: 3000,
      });
      return;
    }

    const role = roleValue[0];
    const payload: Record<string, any> = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim() || null,
      phone: phone.trim() || null,
      isPrimary,
      active,
      contactPriority: contactPriority === "" ? null : Number(contactPriority),
    };

    // Only include role if not UNSPECIFIED (prevents enum mismatch server-side)
    if (role && role !== "UNSPECIFIED") {
      payload.role = role;
    }

    setBusy(true);
    try {
      let saved;
      if (mode === "create") {
        saved = await apiPost(
          `/api/admin/clients/${clientId}/contacts`,
          payload
        );
        publishInlineMessage({
          scope,
          type: "SUCCESS",
          text: `Contact “${payload.firstName} ${payload.lastName}” created.`,
          autoHideMs: 3000,
        });
      } else {
        if (!initialContact?.id) {
          throw new Error("Missing contact id for update");
        }
        saved = await apiPatch(
          `/api/admin/clients/${clientId}/contacts/${initialContact.id}`,
          payload
        );
        publishInlineMessage({
          scope,
          type: "SUCCESS",
          text: `Contact “${payload.firstName} ${payload.lastName}” updated.`,
          autoHideMs: 3000,
        });
      }

      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({
        scope,
        type: "ERROR",
        text: getErrorMessage(
          mode === "create" ? "Create contact failed" : "Update contact failed",
          err
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            mx="4" // ~16px left/right margin at small breakpoints
            maxW="lg" // cap width (try "md"/"lg"/"xl")
            w="full"
            rounded="2xl"
            p="4" // inner padding
            shadow="lg"
          >
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {mode === "create" ? "Add Contact" : "Update Contact"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
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
                    <Text mb="1">Last name</Text>
                    <Input
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Last name"
                    />
                  </div>
                </HStack>

                <HStack gap={3}>
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
                      placeholder="+1 555 555 5555"
                    />
                  </div>
                </HStack>

                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Role</Text>
                    <Select.Root
                      collection={roleCollection}
                      value={roleValue}
                      onValueChange={(e) => setRoleValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select role" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {CONTACT_ROLE_ITEMS.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>

                  <div style={{ flex: 1 }}>
                    <Text mb="1">Priority</Text>
                    <Input
                      type="number"
                      value={contactPriority}
                      onChange={(e) => {
                        const val = e.target.value;
                        setContactPriority(val === "" ? "" : Number(val));
                      }}
                      placeholder="e.g. 100"
                    />
                  </div>
                </HStack>

                <HStack gap={6} mt={2}>
                  <HStack gap={2} align="center">
                    <Switch.Root
                      checked={isPrimary}
                      onCheckedChange={(e) => setIsPrimary(e.checked)}
                    >
                      <Switch.Control />
                      <Switch.Thumb />
                    </Switch.Root>
                    <Text>Primary contact</Text>
                  </HStack>

                  <HStack gap={2} align="center">
                    <Switch.Root
                      checked={active}
                      onCheckedChange={(e) => setActive(e.checked)}
                    >
                      <Switch.Control />
                      <Switch.Thumb />
                    </Switch.Root>
                    <Text>Active</Text>
                  </HStack>
                </HStack>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button onClick={handleSave} loading={busy}>
                  {actionLabel ?? (mode === "create" ? "Create" : "Save")}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
