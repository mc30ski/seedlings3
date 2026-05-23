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
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
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
  /** When true, onSaved receives form data instead of saving to API */
  deferSave?: boolean;
  defaultIsPrimary?: boolean;
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
  deferSave,
  defaultIsPrimary,
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

  // Pre-flight: debounced lookup that warns the admin if an active contact
  // already exists with the same email or phone. Catches the recreate-
  // after-delete and shared-household-email cases while they're still
  // typing, before the workflow's batchSave hits the per-client unique
  // constraint at submit time.
  type ContactMatch = {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    normalizedPhone: string | null;
    isPrimary: boolean;
    client: { id: string; displayName: string };
  };
  const [contactMatches, setContactMatches] = useState<ContactMatch[]>([]);

  // Primary-contact invariant: every client must have exactly one primary.
  // We force isPrimary=true and disable the checkbox when:
  //   - The workflow path passes defaultIsPrimary (first contact ever on a
  //     brand-new client), OR
  //   - CREATE on a real client that has no active primary today, OR
  //   - UPDATE on the sole active primary (can't demote without first
  //     promoting someone else).
  const [primaryForced, setPrimaryForced] = useState(false);
  const [primaryForcedReason, setPrimaryForcedReason] = useState<string>("");

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
    const digits = phone.replace(/\D/g, "");
    return (
      statusValue &&
      kindValue &&
      firstName &&
      (!email || EMAIL_RE.test(email)) &&
      (!phone || digits.length >= 10)
    );
  }

  function hasMissingInfo() {
    return !lastName.trim() || (!email.trim() && !phone.trim());
  }

  // Seed form ONCE per open — re-running on every `initial` reference
  // change would wipe what the user typed whenever the parent re-renders
  // (which happens often during slow workflows: tab refocus, /me polls,
  // alert-badge refreshes, Clerk session refreshes, …). Consumers always
  // close-then-reopen the dialog to switch records, so seed-on-open-only
  // is the right contract.
  const prevOpenRefSeed = useRef(false);
  useEffect(() => {
    if (!open) { prevOpenRefSeed.current = false; return; }
    if (prevOpenRefSeed.current) return;
    prevOpenRefSeed.current = true;
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
      setKindValue([initial?.role ?? CONTACT_KIND[0]]);
      setStatusValue([initial?.status ?? CONTACT_STATUS[0]]);
      setFirstName(initial?.firstName ?? "");
      setLastName(initial?.lastName ?? "");
      setNickname(initial?.nickname ?? "");
      setEmail(initial?.email ?? "");
      setPhone(initial?.phone ?? "");
      setIsPrimary(initial?.isPrimary ?? defaultIsPrimary ?? false);
      setShowMissingWarning(false);
    }
  }, [open]);

  // Resolve primary-forced state on dialog open. The workflow path
  // (clientId === "__deferred__") always forces. For real clients, we look
  // up the live contacts to decide.
  useEffect(() => {
    if (!open) {
      setPrimaryForced(false);
      setPrimaryForcedReason("");
      return;
    }
    const isDeferred = clientId === "__deferred__";
    if (isDeferred) {
      setPrimaryForced(true);
      setPrimaryForcedReason("This is the first contact for a brand-new client, so it's automatically the primary.");
      setIsPrimary(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const client = await apiGet<{ contacts: Array<{ id: string; status: string; isPrimary: boolean }> }>(
          `/api/admin/clients/${clientId}`,
        );
        if (cancelled) return;
        const activeContacts = (client?.contacts ?? []).filter((c) => c.status === "ACTIVE");
        const otherActivePrimaries = activeContacts.filter(
          (c) => c.isPrimary && c.id !== initial?.id,
        );
        if (mode === "CREATE" && otherActivePrimaries.length === 0) {
          setPrimaryForced(true);
          setPrimaryForcedReason("This client has no primary contact yet, so this one will be set as primary.");
          setIsPrimary(true);
          return;
        }
        if (mode === "UPDATE" && initial?.isPrimary && otherActivePrimaries.length === 0) {
          setPrimaryForced(true);
          setPrimaryForcedReason("This is the only primary contact for this client. Set another contact as primary first to change it.");
          setIsPrimary(true);
          return;
        }
        setPrimaryForced(false);
        setPrimaryForcedReason("");
      } catch {
        if (!cancelled) {
          setPrimaryForced(false);
          setPrimaryForcedReason("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, clientId, mode, initial?.id, initial?.isPrimary]);

  // Debounced pre-flight: ~400ms after the admin stops typing email or
  // phone, look up existing contacts with those values and surface a
  // warning. Self-exclusion: when editing, don't flag the contact being
  // edited as a match. Workflow CREATE mode (clientId === "__deferred__")
  // also runs this — it can't compare against the new client (doesn't
  // exist yet) but other-client matches are still useful context.
  useEffect(() => {
    if (!open) { setContactMatches([]); return; }
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    if (!trimmedEmail && !trimmedPhone) { setContactMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const qs = new URLSearchParams();
        if (trimmedEmail) qs.set("email", trimmedEmail);
        if (trimmedPhone) qs.set("phone", trimmedPhone);
        const rows = await apiGet<ContactMatch[]>(`/api/admin/client-contacts/check?${qs}`);
        if (cancelled) return;
        const selfId = initial?.id;
        setContactMatches(Array.isArray(rows) ? rows.filter((r) => r.id !== selfId) : []);
      } catch {
        if (!cancelled) setContactMatches([]);
      }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, email, phone, initial?.id]);

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

    if (deferSave) {
      onSaved?.(payload);
      onOpenChange(false);
      return;
    }

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
                <div style={{ flex: 1 }}>
                  <Text mb="1">Nickname</Text>
                  <Input
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="Optional"
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
                {contactMatches.length > 0 && (
                  <div
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      backgroundColor: "var(--chakra-colors-orange-50)",
                      borderWidth: 1,
                      borderStyle: "solid",
                      borderColor: "var(--chakra-colors-orange-300)",
                      borderLeftWidth: 4,
                      borderLeftColor: "var(--chakra-colors-orange-500)",
                    }}
                  >
                    <Text fontSize="sm" fontWeight="semibold" color="orange.800" mb={1}>
                      Already in use
                    </Text>
                    <Text fontSize="xs" color="orange.700" mb={1}>
                      {contactMatches.length === 1
                        ? "A contact with this email or phone already exists:"
                        : `${contactMatches.length} other contacts share this email or phone:`}
                    </Text>
                    <VStack align="stretch" gap={0.5}>
                      {contactMatches.map((m) => {
                        const matchesEmail =
                          !!m.email && !!email.trim() && m.email.toLowerCase() === email.trim().toLowerCase();
                        const matchesPhone =
                          (!!m.phone && !!phone.trim() && m.phone === phone.trim()) ||
                          (!!m.normalizedPhone && !!phone.trim() && m.normalizedPhone === phone.trim());
                        const why =
                          matchesEmail && matchesPhone
                            ? "email + phone"
                            : matchesEmail
                              ? "email"
                              : matchesPhone
                                ? "phone"
                                : "match";
                        return (
                          <Text key={m.id} fontSize="xs" color="orange.800">
                            • <Text as="span" fontWeight="semibold">{m.firstName} {m.lastName}</Text>
                            {" "}— on <Text as="span" fontWeight="semibold">{m.client.displayName}</Text>
                            {" "}({why})
                          </Text>
                        );
                      })}
                    </VStack>
                    <Text fontSize="xs" color="orange.700" mt={1.5}>
                      Use a different email/phone, or open the existing client to reuse that contact.
                    </Text>
                  </div>
                )}
                <VStack align="stretch" gap={1}>
                  <Checkbox.Root
                    checked={isPrimary}
                    onCheckedChange={(e) => setIsPrimary(!!e.checked)}
                    disabled={primaryForced}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>Primary point of contact</Checkbox.Label>
                  </Checkbox.Root>
                  {primaryForced && primaryForcedReason && (
                    <Text fontSize="xs" color="gray.600" pl="6">
                      {primaryForcedReason}
                    </Text>
                  )}
                </VStack>
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
