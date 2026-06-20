"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Box,
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
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";

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
  const dlgErr = useDialogError();

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
    // Populated when the matching contact has already been bound
    // to a Clerk login. If non-null, adding a new contact with
    // matching email/phone will auto-bind the new row to the SAME
    // Clerk identity so a single sign-in surfaces every client
    // they belong to.
    clerkUserId: string | null;
    client: { id: string; displayName: string };
  };
  const [contactMatches, setContactMatches] = useState<ContactMatch[]>([]);
  // On UPDATE mode, when this contact shares a clerkUserId with
  // other rows on other clients, default-checked to propagate
  // identity changes (name/email/phone) to all linked siblings. The
  // operator can uncheck to make this edit local to the current
  // client only.
  const [applyToLinked, setApplyToLinked] = useState(true);

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
    // Same-client duplicates are a hard block: the operator should
    // either edit the existing contact or change the identity here.
    // Cross-client matches are intentional (same person, new role)
    // and DON'T block save — the inline blue panel explains the
    // consequences and the admin can proceed.
    const sameClientDup = contactMatches.some((m) => m.client.id === clientId);
    return (
      statusValue &&
      kindValue &&
      firstName &&
      (!email || EMAIL_RE.test(email)) &&
      (!phone || digits.length >= 10) &&
      !sameClientDup
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
    dlgErr.clear();
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

    // On UPDATE mode: if this contact has cross-client linked
    // siblings AND the operator hasn't unchecked propagation, set
    // applyToLinked so the backend updates the sibling rows' identity
    // fields too. Default ON because that's almost always the intent.
    const hasOtherClientMatches = contactMatches.some((m) => m.client.id !== clientId);
    const payload = {
      role: (kindValue[0] as ContactKind) ?? CONTACT_KIND[0],
      status: (statusValue[0] as ContactStatus) ?? CONTACT_STATUS[0],
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      nickname: nickname.trim() || null,
      email: email.trim(),
      phone: phone.trim(),
      isPrimary,
      ...(mode === "UPDATE" && hasOtherClientMatches ? { applyToLinked } : {}),
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
      dlgErr.setError(
        getErrorMessage(
          mode === "CREATE" ? "Create contact failed" : "Update contact failed",
          err
        )
      );
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
                {contactMatches.length > 0 && (() => {
                  // Categorize matches: same-client (almost always a
                  // duplicate to block) vs other-client (the
                  // legitimate cross-client case — same person, new
                  // role). The two render differently: same-client
                  // is a hard warning, other-client is informational
                  // with consequence explainer.
                  const sameClient = contactMatches.filter((m) => m.client.id === clientId);
                  const otherClient = contactMatches.filter((m) => m.client.id !== clientId);
                  const anyLinkedToClerk = contactMatches.some((m) => !!m.clerkUserId);
                  return (
                    <VStack align="stretch" gap={2}>
                      {sameClient.length > 0 && (
                        <div
                          style={{
                            padding: "10px 12px",
                            borderRadius: 8,
                            backgroundColor: "var(--chakra-colors-red-50)",
                            borderWidth: 1,
                            borderStyle: "solid",
                            borderColor: "var(--chakra-colors-red-300)",
                            borderLeftWidth: 4,
                            borderLeftColor: "var(--chakra-colors-red-500)",
                          }}
                        >
                          <Text fontSize="sm" fontWeight="semibold" color="red.800" mb={1}>
                            Duplicate on this client
                          </Text>
                          <Text fontSize="xs" color="red.700" mb={1}>
                            A contact with this email or phone already exists on this client:
                          </Text>
                          <VStack align="stretch" gap={0.5}>
                            {sameClient.map((m) => (
                              <Text key={m.id} fontSize="xs" color="red.800">
                                • <Text as="span" fontWeight="semibold">{m.firstName} {m.lastName}</Text>
                                {m.isPrimary && <Text as="span"> · primary</Text>}
                              </Text>
                            ))}
                          </VStack>
                          <Text fontSize="xs" color="red.700" mt={1.5}>
                            Edit the existing contact instead, or change the email/phone here.
                          </Text>
                        </div>
                      )}
                      {otherClient.length > 0 && (
                        <div
                          style={{
                            padding: "10px 12px",
                            borderRadius: 8,
                            backgroundColor: "var(--chakra-colors-blue-50)",
                            borderWidth: 1,
                            borderStyle: "solid",
                            borderColor: "var(--chakra-colors-blue-300)",
                            borderLeftWidth: 4,
                            borderLeftColor: "var(--chakra-colors-blue-500)",
                          }}
                        >
                          <Text fontSize="sm" fontWeight="semibold" color="blue.800" mb={1}>
                            {otherClient.length === 1
                              ? "This person is already a contact on another client"
                              : `This person is already a contact on ${otherClient.length} other clients`}
                          </Text>
                          <VStack align="stretch" gap={0.5} mb={1.5}>
                            {otherClient.map((m) => (
                              <Text key={m.id} fontSize="xs" color="blue.800">
                                • <Text as="span" fontWeight="semibold">{m.firstName} {m.lastName}</Text>
                                {" "}— on <Text as="span" fontWeight="semibold">{m.client.displayName}</Text>
                                {m.clerkUserId && <Text as="span" color="blue.600"> · has login</Text>}
                              </Text>
                            ))}
                          </VStack>
                          <Text fontSize="xs" color="blue.800" fontWeight="semibold" mb={0.5}>
                            If this is the same person, adding them here will:
                          </Text>
                          <VStack align="stretch" gap={0} mb={1}>
                            <Text fontSize="xs" color="blue.700">
                              • {anyLinkedToClerk
                                ? "Share the existing login account — they'll see jobs from both clients when they log in."
                                : "Share a login account if they ever sign up — they'll see jobs from both clients."}
                            </Text>
                            <Text fontSize="xs" color="blue.700">
                              • Edits to their name, phone, or email will offer to propagate to all linked contacts.
                            </Text>
                          </VStack>
                          <Text fontSize="xs" color="blue.700" fontStyle="italic">
                            If this is a different person who happens to share an email or phone, change the email/phone here before saving.
                          </Text>
                          {mode === "UPDATE" && (
                            <Box mt={2.5} pt={2} borderTopWidth="1px" borderColor="blue.200">
                              <HStack as="label" align="flex-start" gap={2} cursor="pointer">
                                <input
                                  type="checkbox"
                                  checked={applyToLinked}
                                  onChange={(e) => setApplyToLinked(e.target.checked)}
                                  style={{ marginTop: 3 }}
                                />
                                <VStack align="start" gap={0}>
                                  <Text fontSize="xs" color="blue.900" fontWeight="semibold">
                                    Apply name, email, and phone changes to all {otherClient.length + 1} linked contacts
                                  </Text>
                                  <Text fontSize="2xs" color="blue.700">
                                    Uncheck to make this edit local to this client only (identity will drift between rows).
                                  </Text>
                                </VStack>
                              </HStack>
                            </Box>
                          )}
                        </div>
                      )}
                    </VStack>
                  );
                })()}
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
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
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
