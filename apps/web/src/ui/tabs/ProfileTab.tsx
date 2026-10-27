"use client";
import type { WorkerType } from "@repo/money";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Input,
  Text,
  VStack,
  Spinner,
} from "@chakra-ui/react";
import { Check, X } from "lucide-react";
import AddressAutocomplete from "@/src/ui/components/AddressAutocomplete";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/src/lib/api";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { type Me } from "@/src/lib/types";
import { fmtDate, fmtDateOpts, fmtDateLong, fmtTimeOpts, bizToday, bizDateKey, bizDaysBetween } from "@/src/lib/dates";
import { useOffline } from "@/src/lib/offline";
import { getAllActions, deleteAction, retryAction, clearAllActions, subscribeQueue, type QueuedAction } from "@/src/lib/offlineQueue";
import { usePushNotifications } from "@/src/lib/usePushNotifications";
import { getSeasonOverride, setSeasonOverride, getNaturalSeason, type SeasonOverride } from "@/src/lib/season";
import { useAppTheme } from "@/src/lib/useAppTheme";
import { SURFACES, THEME_IDS, THEME_LABELS, THEME_DESCRIPTIONS } from "@/src/styles/themeTokens";
import { useClerk } from "@clerk/clerk-react";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import WorkerComplianceSection from "@/src/ui/components/WorkerComplianceSection";
import { payClassLabel } from "../../lib/paymentMath";
import { scopeFromMe } from "@/src/lib/roles";

type Worker = { id: string; displayName?: string | null; email?: string | null; workerType?: WorkerType | null };

/** Normalize a typed US phone number to E.164 (+1XXXXXXXXXX). Null if not a valid 10-digit US number. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Render a stored phone (any format) as (XXX) XXX-XXXX for display. */
function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return raw;
}

type Props = {
  me: Me | null;
  /**
   * THIS TAB TAKES NO AUTHORIZATION PROPS. It used to take two.
   *
   * A boolean prop meaning "this is the staff build of the Profile tab" sat
   * here, and index.tsx passed it BARE — i.e. true for everybody. It opened the
   * "whose profile" picker, which reads `/workers` (`people.view`) and
   * saves through `/users/:id/profile` (`people.manage`), so somebody with
   * neither was shown a picker that 403'd on both. A second prop said which
   * tab you had navigated in through, so an edit could be restricted to
   * "the owner build of the Profile tab" rather than to an entitlement — the same person
   * got a different answer depending on how they got here.
   *
   * There is one Profile tab. Inside, each question is asked of the
   * capability whose endpoint it is about, all derived from `me`:
   *   `people.view`    → the "whose profile" picker (`GET /workers`).
   *   `people.manage`  → saving somebody else's profile.
   *   `payroll.manage` → the hourly-wage field.
   *   `payroll.view`   → somebody else's earnings section.
   *   `settings.manage`→ the payment-comms override.
   *   `schedule.manage`→ the season override.
   * `isSelf` still decides the self-only sections (calendar feeds, offline,
   * season) — that is a question about WHOSE profile is open, not about
   * authority, and the two are genuinely different.
   */
  onProfileUpdated?: () => void;
};

export default function ProfileTab({ me, onProfileUpdated }: Props) {
  // The other-person selector — gated on `people.view` below.
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedUserId, setSelectedUserId] = usePersistedState<string>("profile_userId", "");
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  // Profile fields
  const [firstName, setFirstName] = useState("");
  const [savedFirstName, setSavedFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [savedLastName, setSavedLastName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState("");
  const [homeBase, setHomeBase] = useState("");
  const [savedHomeBase, setSavedHomeBase] = useState("");
  const [availableDays, setAvailableDays] = useState<number[]>([]);
  const [savedAvailableDays, setSavedAvailableDays] = useState<number[]>([]);
  const [availableHours, setAvailableHours] = useState(4);
  const [savedAvailableHours, setSavedAvailableHours] = useState(4);
  // Hourly wage — writing it needs `payroll.manage`, which people.ts
  // checks on `PATCH /users/:id`. Used by the Reconcile → Payroll export
  // to compute regular wages vs additional earnings.
  const [hourlyWage, setHourlyWage] = useState("0.00");
  const [savedHourlyWage, setSavedHourlyWage] = useState("0.00");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  // Payment comms mode — the target user's per-profile override (null = use org default)
  // plus the org-wide default fetched from /api/settings.
  const [commsMode, setCommsMode] = useState<"SERVER" | "CLAIMER" | null>(null);
  const [orgCommsMode, setOrgCommsMode] = useState<"SERVER" | "CLAIMER">("CLAIMER");
  const [commsBusy, setCommsBusy] = useState(false);

  // The payment-comms override is a business-wide setting, so it is
  // `settings.manage` — the entitlement and nothing else. It was
  // a role check ANDed with "and you are on the staff Profile
  // tab".
  // `payroll.manage`, matching the server. This was `settings.manage`
  // wearing the name `canManageWage`; the two are different entitlements and the
  // write path (`PATCH /users/:id`, people.ts) checks the payroll one.
  const canManageWage = scopeFromMe(me).can("payroll.manage");
  // May this person look at somebody ELSE's profile? That is the question
  // the `canViewOthers` prop was standing in for. The picker reads `/workers`
  // (`people.view`); saving writes `/users/:id/profile` (`people.manage`).
  const canViewOthers = scopeFromMe(me).can("people.view");
  const canEditOthers = scopeFromMe(me).can("people.manage");
  // Capability answers for the help copy, which must ask the same question
  // the route does. This component was never given a `scope` prop.
  const scope = scopeFromMe(me);

  const phoneError = phone.trim() !== "" && normalizePhone(phone) === null;

  // Hourly wage only counts toward unsaved-changes when the viewer is
  // someone with `settings.manage` — non-super viewers see it read-only and the input is
  // disabled.
  const hourlyWageChanged = canManageWage && hourlyWage !== savedHourlyWage;
  const hasChanges = firstName !== savedFirstName ||
    lastName !== savedLastName ||
    displayName !== savedDisplayName ||
    phone !== savedPhone ||
    homeBase !== savedHomeBase ||
    JSON.stringify(availableDays) !== JSON.stringify(savedAvailableDays) ||
    availableHours !== savedAvailableHours ||
    hourlyWageChanged;

  // Warn on page refresh/close with unsaved changes
  useEffect(() => {
    if (!hasChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  // The user we're viewing — admin must select a user; worker is always self
  // Falls back to YOURSELF, not to nobody. This was `selectedUserId || ""`,
  // so anyone who could view others landed on Profile with no user selected
  // and therefore no Appearance section, no calendar feed and no season
  // override — all of which are self-only. They had to pick themselves out
  // of a dropdown to see their own profile. Picking someone else still
  // works; clearing the picker returns you to your own.
  const targetUserId = canViewOthers ? (selectedUserId || me?.id || "") : (me?.id ?? "");
  const isSelf = !!targetUserId && targetUserId === me?.id;

  // Load workers list for admin
  useEffect(() => {
    if (!canViewOthers) return;
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [canViewOthers]);

  // Listen for external user selection (from clicking a user name in other tabs)
  useEffect(() => {
    const onSelect = (e: Event) => {
      const { userId } = (e as CustomEvent).detail || {};
      if (userId) {
        setSelectedUserId(userId);
      }
    };
    window.addEventListener("profile:selectUser", onSelect as EventListener);
    return () => window.removeEventListener("profile:selectUser", onSelect as EventListener);
  }, [me?.id]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
        setSearchText("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  // Load profile data for target user
  useEffect(() => {
    if (!targetUserId) return;
    if (isSelf && me) {
      setFirstName(me.firstName ?? ""); setSavedFirstName(me.firstName ?? "");
      setLastName(me.lastName ?? ""); setSavedLastName(me.lastName ?? "");
      setDisplayName(me.displayName ?? ""); setSavedDisplayName(me.displayName ?? "");
      setPhone(formatPhoneDisplay(me.phone ?? "")); setSavedPhone(formatPhoneDisplay(me.phone ?? ""));
      setHomeBase(me.homeBaseAddress ?? ""); setSavedHomeBase(me.homeBaseAddress ?? "");
      setAvailableDays(me.availableDays ?? []); setSavedAvailableDays(me.availableDays ?? []);
      setAvailableHours(me.availableHoursPerDay ?? 4); setSavedAvailableHours(me.availableHoursPerDay ?? 4);
      const meWage = (me as any).hourlyWage;
      const meWageStr = meWage == null ? "0.00" : Number(meWage).toFixed(2);
      setHourlyWage(meWageStr); setSavedHourlyWage(meWageStr);
      setCommsMode(me.paymentCommsMode ?? null);
      return;
    }
    // Admin viewing another user — fetch their data
    setLoading(true);
    apiGet<any>(`/api/users/${targetUserId}`)
      .then((u) => {
        setFirstName(u?.firstName ?? ""); setSavedFirstName(u?.firstName ?? "");
        setLastName(u?.lastName ?? ""); setSavedLastName(u?.lastName ?? "");
        setDisplayName(u?.displayName ?? ""); setSavedDisplayName(u?.displayName ?? "");
        setPhone(formatPhoneDisplay(u?.phone ?? "")); setSavedPhone(formatPhoneDisplay(u?.phone ?? ""));
        setHomeBase(u?.homeBaseAddress ?? ""); setSavedHomeBase(u?.homeBaseAddress ?? "");
        const days = u?.availableDays ? (Array.isArray(u.availableDays) ? u.availableDays : JSON.parse(u.availableDays)) : [];
        setAvailableDays(days); setSavedAvailableDays(days);
        const hours = u?.availableHoursPerDay ?? 4;
        setAvailableHours(hours);
        setSavedAvailableHours(hours);
        const uWage = u?.hourlyWage;
        const uWageStr = uWage == null ? "0.00" : Number(uWage).toFixed(2);
        setHourlyWage(uWageStr);
        setSavedHourlyWage(uWageStr);
        setCommsMode(u?.paymentCommsMode ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [targetUserId, isSelf, me]);

  // Load org-wide DEFAULT_PAYMENT_COMMUNICATIONS_MODE so we can show "(org default)" labels.
  useEffect(() => {
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((list) => {
        if (!Array.isArray(list)) return;
        const row = list.find((s) => s.key === "DEFAULT_PAYMENT_COMMUNICATIONS_MODE");
        if (row?.value === "SERVER" || row?.value === "CLAIMER") setOrgCommsMode(row.value);
      })
      .catch(() => {});
  }, []);

  async function setCommsModeFor(target: "SERVER" | "CLAIMER" | null) {
    if (!targetUserId) return;
    setCommsBusy(true);
    try {
      await apiPatch(`/api/users/${targetUserId}/payment-comms-mode`, { mode: target });
      setCommsMode(target);
      publishInlineMessage({ type: "SUCCESS", text: "Payment communications mode updated." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update failed.", err) });
    } finally {
      setCommsBusy(false);
    }
  }

  async function saveProfile() {
    setSaving(true);
    try {
      const endpoint = canEditOthers && !isSelf
        ? `/api/users/${targetUserId}/profile`
        : "/api/me/profile";
      const normPhone = phone.trim() ? normalizePhone(phone) : null;
      // hourlyWage needs `payroll.manage` — only include it when the
      // editor holds that, both to avoid a 403 and because
      // /api/me/profile rejects the field outright.
      const payload: any = {
        firstName,
        lastName,
        displayName,
        phone: normPhone,
        homeBaseAddress: homeBase,
        availableDays,
        availableHoursPerDay: availableHours,
      };
      // hourlyWage needs `payroll.manage` on the write side. Only include
      // it when the viewer holds that — the server checks it independently.
      if (canManageWage) {
        const wageNum = Number(hourlyWage);
        payload.hourlyWage = Number.isFinite(wageNum) && wageNum >= 0 ? wageNum : 0;
      }
      await apiPatch(endpoint, payload);
      const phoneDisplay = formatPhoneDisplay(normPhone ?? "");
      setPhone(phoneDisplay);
      setSavedPhone(phoneDisplay);
      setSavedFirstName(firstName);
      setSavedLastName(lastName);
      setSavedDisplayName(displayName);
      setSavedHomeBase(homeBase);
      setSavedAvailableDays([...availableDays]);
      setSavedAvailableHours(availableHours);
      setSavedHourlyWage(hourlyWage);
      publishInlineMessage({ type: "SUCCESS", text: "Profile saved." });
      onProfileUpdated?.();
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
    setSaving(false);
  }

  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [workers]);

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workers.filter((w) => (w.displayName || w.email || "").toLowerCase().includes(searchLc))
    : workers;
  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > 10;

  const targetUser = isSelf
    ? { displayName: me?.displayName, email: me?.email, workerType: me?.workerType }
    : workers.find((w) => w.id === targetUserId);

  const workerTypeLabel = (wt: WorkerType | null | undefined) =>
    wt === "EMPLOYEE" ? "W-2 Employee" : wt === "CONTRACTOR" ? "1099 Contractor" : payClassLabel(wt);

  return (
    <Box w="full" pb={8}>
      <TabExplainer explainerId={`seedlings:profileTab:guideOpen:${canViewOthers ? "others" : "self"}`}>
        <ExplainerText>
          Your contact details, and how you want to be reached. Keeping your phone and email
          current matters — job alerts and payment notices go there.
        </ExplainerText>
        <ExplainerText>
          This is also where you <Em>read and sign the policies</Em> you owe, and where you
          can open one you have already signed. Policies appear <Em>only on your own</Em>{" "}
          profile, and nobody can sign on anyone else&rsquo;s behalf.
        </ExplainerText>
        {canViewOthers && (
          <CapabilitySection capability="people.manage" scope={scope}>
            <ExplainerText>
              Pick a person above to view or edit theirs — contact details, and their hourly
              wage, which is never shown to the person on their own profile.
              Their signing status lives on the Compliance tab, not here.
            </ExplainerText>
          </CapabilitySection>
        )}
      </TabExplainer>
      {/* The other-person selector — `people.view`. */}
      {canViewOthers && (
        <HStack mb={4} gap={2} align="center" wrap="wrap">
          <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
            User:
          </Text>
          <Box ref={dropRef} position="relative">
            <Input
              size="sm"
              w="240px"
              placeholder={selectedUserId ? (workerNameMap[selectedUserId] || selectedUserId) : "Select a user..."}
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
                if (!dropOpen) setDropOpen(true);
              }}
              onFocus={() => setDropOpen(true)}
            />
            {dropOpen && (
              <Box
                position="fixed"
                zIndex={9999}
                bg="bg"
                borderWidth="1px"
                rounded="md"
                shadow="lg"
                maxH="260px"
                overflowY="auto"
                w="240px"
                mt={1}
                style={{
                  top: (dropRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                  left: dropRef.current?.getBoundingClientRect().left ?? 0,
                }}
              >
                {limited.map((w) => (
                  <Box
                    key={w.id} px={3} py={1.5} cursor="pointer" fontSize="sm"
                    bg={selectedUserId === w.id ? "blue.faint" : undefined}
                    _hover={{ bg: "gray.subtle" }}
                    onClick={() => { setSelectedUserId(w.id); setDropOpen(false); setSearchText(""); }}
                  >
                    <Text>{w.displayName || w.email || w.id}</Text>
                  </Box>
                ))}
                {hasMore && (
                  <Text px={3} py={1} fontSize="xs" color="fg.muted">
                    ...{filtered.length - 10} more — type to search
                  </Text>
                )}
              </Box>
            )}
          </Box>
          {selectedUserId && (
            <Button size="xs" variant="ghost" onClick={() => { setSelectedUserId(""); setSearchText(""); }}>
              <X size={12} />
            </Button>
          )}
        </HStack>
      )}

      {canViewOthers && !targetUserId ? (
        <Box py={10} textAlign="center">
          <Text color="fg.muted" fontSize="sm">Select a user above to view their profile.</Text>
        </Box>
      ) : loading ? (
        <Box py={10} textAlign="center"><Spinner size="lg" /></Box>
      ) : (
        <VStack align="stretch" gap={4} w="full">
          {/* Account — pinned to the top so Manage Account + Sign Out
              are the first things you see when you land on the page
              from the title-bar avatar. */}
          {isSelf && <AccountSection />}
          {/* Compliance — worker's outstanding sign requirements + history.
              Rendered above Personal Information so a worker sees pending
              policies before anything else. Self-hides when the worker has
              no applicable policies. */}
          {isSelf && <WorkerComplianceSection />}
          {/* Name & info card */}
          <Card.Root variant="outline">
            <Card.Header py="2" px="3" pb="0">
              <Text fontWeight="semibold">Personal Information</Text>
            </Card.Header>
            <Card.Body py="2" px="3">
              <VStack align="stretch" gap={3}>
                <HStack gap={3}>
                  <Box flex="1">
                    <Text fontSize="xs" fontWeight="medium" mb="1">First Name</Text>
                    <Input
                      size="sm"
                      value={firstName}
                      onChange={(e) => {
                        setFirstName(e.target.value);
                        // Auto-update display name if it matches the old first+last pattern
                        const oldAuto = [savedFirstName, savedLastName].filter(Boolean).join(" ");
                        if (!savedDisplayName || savedDisplayName === oldAuto || displayName === oldAuto) {
                          setDisplayName([e.target.value, lastName].filter(Boolean).join(" "));
                        }
                      }}
                      placeholder="First name"
                    />
                  </Box>
                  <Box flex="1">
                    <Text fontSize="xs" fontWeight="medium" mb="1">Last Name</Text>
                    <Input
                      size="sm"
                      value={lastName}
                      onChange={(e) => {
                        setLastName(e.target.value);
                        const oldAuto = [savedFirstName, savedLastName].filter(Boolean).join(" ");
                        if (!savedDisplayName || savedDisplayName === oldAuto || displayName === oldAuto) {
                          setDisplayName([firstName, e.target.value].filter(Boolean).join(" "));
                        }
                      }}
                      placeholder="Last name"
                    />
                  </Box>
                </HStack>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb="1">Display Name</Text>
                  <Input
                    size="sm"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="How your name appears in the app"
                  />
                  <Text fontSize="xs" color="fg.muted" mt="0.5">Auto-generated from first + last name. Edit to customize.</Text>
                </Box>
                <VStack align="stretch" gap={1} w="full">
                  {targetUser?.email && (
                    <HStack fontSize="sm" alignItems="flex-start" w="full">
                      <Text color="fg.muted" w="80px" flexShrink={0}>Email:</Text>
                      <Text flex="1" minW={0} wordBreak="break-all">{targetUser.email}</Text>
                    </HStack>
                  )}
                  <Box pt={1}>
                    <Text fontSize="xs" fontWeight="medium" mb="1">Phone</Text>
                    <Input
                      size="sm"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="(919) 555-0123"
                      borderColor={phoneError ? "red.strong" : undefined}
                    />
                    {phoneError ? (
                      <Text fontSize="xs" color="red.fg" mt="0.5">Enter a valid 10-digit US phone number.</Text>
                    ) : (
                      <Text fontSize="xs" color="fg.muted" mt="0.5">Used for SMS job and payment notifications.</Text>
                    )}
                  </Box>
                </VStack>
                <HStack fontSize="sm">
                  <Text color="fg.muted" w="80px">Type:</Text>
                  <Badge
                    colorPalette={
                      targetUser?.workerType === "EMPLOYEE" ? "blue"
                      : targetUser?.workerType === "CONTRACTOR" ? "orange"
                      : targetUser?.workerType === "UNPAID" ? "purple"
                      : "gray"
                    }
                  >
                    {workerTypeLabel(targetUser?.workerType)}
                  </Badge>
                </HStack>
                {/* LLC Owner — its own row rather than a chip tacked onto
                    Type, because it is not a worker classification: the
                    owner is also an EMPLOYEE or CONTRACTOR and both facts
                    matter. Same purple solid badge the Users directory
                    uses, so the two surfaces agree.

                    Self-view only. `isOwner` rides on /me; the
                    /api/workers list someone with people authority picks from does not carry
                    it, so the directory viewing someone else's profile can't
                    render this without widening that payload. */}
                {isSelf && me?.isOwner && (
                  <HStack fontSize="sm" align="flex-start">
                    <Text color="fg.muted" w="80px">Owner:</Text>
                    <Box flex="1">
                      <Badge colorPalette="purple" variant="solid">LLC Owner</Badge>
                      <Text fontSize="xs" color="fg.muted" mt="0.5">
                        You are the registered owner of the business. Owner
                        draws and capital contributions are recorded on the
                        Ledger, not through payroll.
                      </Text>
                    </Box>
                  </HStack>
                )}
                {isSelf && (
                  <Box pt={2} borderTopWidth="1px" borderColor="gray.emphasized">
                    <VStack align="stretch" gap={1}>
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="blue"
                        alignSelf="flex-start"
                        onClick={async () => {
                          try {
                            await apiPost("/api/me/sync");
                            onProfileUpdated?.();
                            publishInlineMessage({ type: "SUCCESS", text: "Profile synced from Clerk." });
                          } catch (e) {
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Sync failed", e) });
                          }
                        }}
                      >
                        Sync Authentication
                      </Button>
                      <Text fontSize="2xs" color="fg.muted">
                        Pull the latest email and name from your Clerk account.
                      </Text>
                    </VStack>
                  </Box>
                )}
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Permissions card — self-view only (holders of `people.manage` manage other users'
              privileges via UsersTab). Reads `me.privileges` which is the
              already-resolved effective state from the server. */}
          {isSelf && me?.privileges && (
            <Card.Root variant="outline">
              <Card.Header py="2" px="3" pb="0">
                <Text fontWeight="semibold">Permissions</Text>
              </Card.Header>
              <Card.Body py="2" px="3">
                <VStack align="stretch" gap={2}>
                  <HStack fontSize="sm" align="flex-start">
                    <Text w="24px">📦</Text>
                    <Box flex="1">
                      <Text fontWeight="medium">Use company supplies</Text>
                      <Text fontSize="xs" color="fg.muted">
                        Pull from already-purchased inventory on jobs you've claimed.
                        The per-unit cost is deducted from your payout.
                      </Text>
                    </Box>
                    <Badge colorPalette={me.privileges.canPullInventory ? "green" : "gray"}>
                      {me.privileges.canPullInventory ? "Enabled" : "Not enabled"}
                    </Badge>
                  </HStack>
                  <HStack fontSize="sm" align="flex-start">
                    <Text w="24px">💳</Text>
                    <Box flex="1">
                      <Text fontWeight="medium">Charge business expenses</Text>
                      <Text fontSize="xs" color="fg.muted">
                        Record new expenses paid on the company account (gas, parts, dump
                        fees, etc.). Without this privilege, ask someone with people authority to log out-of-pocket
                        purchases for you.
                      </Text>
                    </Box>
                    <Badge colorPalette={me.privileges.canChargeBusinessExpenses ? "green" : "gray"}>
                      {me.privileges.canChargeBusinessExpenses ? "Enabled" : "Not enabled"}
                    </Badge>
                  </HStack>
                  {!me.privileges.canPullInventory && !me.privileges.canChargeBusinessExpenses && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Job expenses are recorded by someone with people authority on your behalf. Reach out to your admin
                      if anything needs to be logged.
                    </Text>
                  )}
                </VStack>
              </Card.Body>
            </Card.Root>
          )}

          {/* Payment comms — how this user's payment-request messages get sent.
              Everyone can see the effective value; `settings.manage` changes the
              per-user override. */}
          {targetUserId && (() => {
            const effective: "SERVER" | "CLAIMER" = commsMode ?? orgCommsMode;
            const source = commsMode ? "your override" : "org default";
            return (
              <Card.Root variant="outline">
                <Card.Header py="2" px="3" pb="0">
                  <Text fontWeight="semibold">Payment Communications Mode</Text>
                </Card.Header>
                <Card.Body py="2" px="3">
                  <VStack align="stretch" gap={2}>
                    <Text fontSize="xs" color="fg.muted">
                      Controls how payment-request messages reach clients when {isSelf ? "you" : "this user"} complete{isSelf ? "" : "s"} a job.
                      <Text as="span" display="block" mt={1}>
                        <Text as="span" fontWeight="medium">Server</Text> = backend sends via Twilio/Resend.{" "}
                        <Text as="span" fontWeight="medium">Claimer</Text> = {isSelf ? "you" : "the claimer"} text{isSelf ? "" : "s"} or email{isSelf ? "" : "s"} the client from their own device, using a prepared message.
                      </Text>
                    </Text>
                    <HStack fontSize="sm" align="center">
                      <Box flex="1">
                        <Text fontWeight="medium">Mode</Text>
                        <Text fontSize="xs" color="fg.muted">
                          {effective === "SERVER" ? "Server-managed" : "Claimer-managed"} ({source})
                        </Text>
                      </Box>
                      <Badge colorPalette={effective === "SERVER" ? "blue" : "purple"} variant="subtle">
                        {effective}
                      </Badge>
                    </HStack>
                    {canManageWage && (
                      <HStack gap={2} wrap="wrap">
                        <Button
                          size="xs"
                          variant={commsMode === null ? "solid" : "outline"}
                          colorPalette="gray"
                          loading={commsBusy}
                          onClick={() => void setCommsModeFor(null)}
                        >
                          Use org default ({orgCommsMode})
                        </Button>
                        <Button
                          size="xs"
                          variant={commsMode === "SERVER" ? "solid" : "outline"}
                          colorPalette="blue"
                          loading={commsBusy}
                          onClick={() => void setCommsModeFor("SERVER")}
                        >
                          Force Server
                        </Button>
                        <Button
                          size="xs"
                          variant={commsMode === "CLAIMER" ? "solid" : "outline"}
                          colorPalette="purple"
                          loading={commsBusy}
                          onClick={() => void setCommsModeFor("CLAIMER")}
                        >
                          Force Claimer
                        </Button>
                      </HStack>
                    )}
                  </VStack>
                </Card.Body>
              </Card.Root>
            );
          })()}

          {/* Home base card */}
          <Card.Root variant="outline">
            <Card.Header py="2" px="3" pb="0">
              <Text fontWeight="semibold">Home Base Address</Text>
            </Card.Header>
            <Card.Body py="2" px="3">
              <VStack align="stretch" gap={2}>
                <Text fontSize="xs" color="fg.muted">
                  Used as the starting point for route optimization.
                </Text>
                <AddressAutocomplete
                  value={homeBase}
                  onChange={setHomeBase}
                  placeholder="e.g. 123 Main St, Chapel Hill, NC"
                  showValidation
                />
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Available days */}
          <Card.Root variant="outline">
            <Card.Header py="2" px="3" pb="0">
              <Text fontWeight="semibold">Available Days</Text>
            </Card.Header>
            <Card.Body py="2" px="3">
              <VStack align="stretch" gap={2}>
                <Text fontSize="xs" color="fg.muted">
                  Select which days of the week you're typically available to work.
                </Text>
                <Box display="flex" gap={2} flexWrap="wrap">
                  {[
                    { value: 6, label: "Sat" },
                    { value: 0, label: "Sun" },
                    { value: 1, label: "Mon" },
                    { value: 2, label: "Tue" },
                    { value: 3, label: "Wed" },
                    { value: 4, label: "Thu" },
                    { value: 5, label: "Fri" },
                  ].map((day) => {
                    const selected = availableDays.includes(day.value);
                    return (
                      <Button
                        key={day.value}
                        size="sm"
                        variant={selected ? "solid" : "outline"}
                        colorPalette={selected ? "green" : "gray"}
                        onClick={() => {
                          setAvailableDays((prev) =>
                            selected ? prev.filter((d) => d !== day.value) : [...prev, day.value].sort()
                          );
                        }}
                        minW="50px"
                      >
                        {day.label}
                      </Button>
                    );
                  })}
                </Box>
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Hours per day */}
          <Card.Root variant="outline">
            <Card.Header py="2" px="3" pb="0">
              <Text fontWeight="semibold">Hours Per Day</Text>
            </Card.Header>
            <Card.Body py="2" px="3">
              <VStack align="stretch" gap={2}>
                <Text fontSize="xs" color="fg.muted">
                  How many hours per day you're typically available to work.
                </Text>
                <HStack gap={3}>
                  <input
                    type="range"
                    min={2}
                    max={12}
                    step={0.5}
                    value={availableHours}
                    onChange={(e) => setAvailableHours(Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <Text fontSize="sm" fontWeight="semibold" minW="50px" textAlign="center">
                    {availableHours}h
                  </Text>
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Hourly Wage — visible to everyone (workers see their own
              rate on file). Editable only on a caller with settings authority Profile tab; the
              server enforces the same gate by requiring the
              `payroll.manage` capability. Drives the
              Reconcile → Payroll export's Regular Wages column.
              $0.00 is treated as "no rate on file" — Regular Wages
              renders as $0 and Additional Earnings absorbs the full
              target gross, matching how contractors are paid
              through Gusto. */}
          <Card.Root variant="outline">
            <Card.Header py="2" px="3" pb="0">
              <Text fontWeight="semibold">Hourly Wage</Text>
            </Card.Header>
            <Card.Body py="2" px="3">
              <VStack align="stretch" gap={2}>
                <Text fontSize="xs" color="fg.muted">
                  {canManageWage
                    ? "Used by Reconcile → Payroll. For employees/trainees, this is the rate Gusto auto-applies to logged hours. Contractors typically leave this at $0 (paid lump-sum via Additional Earnings)."
                    : isSelf
                      ? "Your hourly rate on file. Only someone with payroll authority can update this."
                      : "Hourly rate on file. Only someone with payroll authority can update this."}
                </Text>
                <HStack gap={2} align="center">
                  <Text fontSize="sm" fontWeight="semibold">$</Text>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={hourlyWage}
                    disabled={!canManageWage}
                    onChange={(e) => setHourlyWage(e.target.value)}
                    onBlur={() => {
                      const n = Number(hourlyWage);
                      setHourlyWage(Number.isFinite(n) && n >= 0 ? n.toFixed(2) : "0.00");
                    }}
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      border: "1px solid var(--chakra-colors-border)",
                      borderRadius: "4px",
                      fontSize: "14px",
                      background: canManageWage ? undefined : "var(--chakra-colors-gray-muted)",
                      color: canManageWage ? undefined : "var(--chakra-colors-gray-fg)",
                      cursor: canManageWage ? "text" : "not-allowed",
                    }}
                  />
                  <Text fontSize="sm" color="fg.muted">/hr</Text>
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Unsaved changes warning */}
          {hasChanges && (
            <Box p={2} bg="yellow.faint" borderWidth="1px" borderColor="yellow.emphasized" rounded="md">
              <Text fontSize="xs" color="yellow.fg">You have unsaved changes.</Text>
            </Box>
          )}

          {/* Save button */}
          <Box>
            <Button
              size="sm"
              colorPalette="green"
              onClick={saveProfile}
              disabled={saving || !hasChanges || phoneError}
            >
              {saving ? "Saving..." : "Save Profile"}
            </Button>
          </Box>

          {/* Earnings. Your own always; somebody ELSE's needs `payroll.view`,
              which is what `GET /users/:id/earnings-summary` now requires —
              it used to be `people.view`. Checked here rather than left to
              the request, because the component swallowed its own 403 and
              rendered nothing: graceful by accident, and indistinguishable
              from a worker who has simply never been paid. */}
          {(isSelf || scopeFromMe(me).can("payroll.view")) && (
            <EarningsSection targetUserId={targetUserId} isSelf={isSelf} />
          )}

          {/* Self-only sections — shown on any tab when viewing your own profile.
              Gate on `isSelf` for features any user gets.
              Gate on `isSelf && holds(me, "some.capability")` for a
              capability-restricted feature. */}
          {isSelf && <NotificationsSection />}
          {isSelf && <CalendarFeedsSection />}
          {isSelf && <OfflineSection />}
          {/* High contrast exists for reading a phone in direct sun — a worker on
              a lawn, not someone with people authority at a desk. */}
          {isSelf && <ThemeSection />}
          {isSelf && scopeFromMe(me).can("schedule.manage") && <SeasonSection />}
          {/* The perspective picker shows whenever there is more than one perspective to
              choose between, and stays visible while one is active so the
              person can switch back without using the banner. It no longer
              needs to ask what they REALLY are: `perspectives` is the same
              list either way, because a perspective narrows rather than
              replaces. */}
        </VStack>
      )}
    </Box>
  );
}

function AccountSection() {
  const { openUserProfile, signOut } = useClerk();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  return (
    <Card.Root variant="outline">
      <Card.Header py="2" px="3" pb="0">
        <Text fontWeight="semibold">Account</Text>
      </Card.Header>
      <Card.Body py="3" px="3">
        <VStack align="stretch" gap={2}>
          <HStack gap={3} align="flex-start">
            <Button
              size="sm"
              variant="outline"
              colorPalette="blue"
              onClick={() => openUserProfile()}
            >
              Manage Account
            </Button>
            <Text fontSize="xs" color="fg.muted" flex="1" pt={1}>
              Email, phone, password, two-factor, connected accounts, and active sessions.
            </Text>
          </HStack>
          <HStack gap={3} align="flex-start">
            <Button
              size="sm"
              variant="outline"
              colorPalette="red"
              onClick={() => setConfirmSignOut(true)}
            >
              Sign Out
            </Button>
            <Text fontSize="xs" color="fg.muted" flex="1" pt={1}>
              Ends your session on this device.
            </Text>
          </HStack>
        </VStack>
      </Card.Body>
      <ConfirmDialog
        open={confirmSignOut}
        title="Sign out?"
        message="You'll be returned to the public homepage and have to sign in again to continue."
        confirmLabel="Sign out"
        confirmColorPalette="red"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={async () => {
          setConfirmSignOut(false);
          // Redirect to "/" after the session ends so the page reflects
          // the signed-out state cleanly (rather than landing on a
          // signed-in-only tab whose data has gone stale).
          await signOut(() => { window.location.href = "/"; });
        }}
      />
    </Card.Root>
  );
}

function NotificationsSection() {
  const push = usePushNotifications();


  // Best-effort label from user-agent — short, recognizable.
  const deviceLabel = (ua?: string | null, label?: string | null) => {
    if (label) return label;
    const u = ua || "";
    if (/iPhone/.test(u)) return "iPhone";
    if (/iPad/.test(u)) return "iPad";
    if (/Android/.test(u)) return "Android";
    if (/Mac OS X/.test(u)) return "Mac";
    if (/Windows/.test(u)) return "Windows";
    return "Device";
  };

  // Track whether the Home-tab banner was dismissed, so we can offer a one-tap
  // "restore" button right here in the Profile notifications section.
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("seedlings_pushBannerDismissed") === "1"; } catch { return false; }
  });

  // Detect this-device row so we can label it and disable the disable-button.
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      try {
        const reg = await navigator.serviceWorker.ready;
        const s = await reg.pushManager.getSubscription();
        if (!cancelled) setThisEndpoint(s?.endpoint ?? null);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [push.devices.length]);

  return (
    <Card.Root variant="outline" mt={4}>
      <Card.Header py="2" px="3" pb="0">
        <Text fontWeight="semibold">Notifications</Text>
      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={3}>
          {push.status === "unsupported" && (
            <Text fontSize="xs" color="fg.muted">
              Your browser doesn't support push notifications.
            </Text>
          )}

          {push.status === "needs-pwa-install" && (
            <Text fontSize="xs" color="fg.muted">
              Add Seedlings to your iPhone Home Screen first, then open it from there to enable notifications.
            </Text>
          )}

          {push.status === "denied" && (
            <Box p={2} bg="yellow.faint" borderWidth="1px" borderColor="yellow.emphasized" rounded="md">
              <Text fontSize="xs" color="yellow.fg">
                Notifications are blocked in your browser. To turn them back on:
                {/iPhone|iPad|iPod/.test(navigator.userAgent || "")
                  ? " open the iPhone Settings app → Notifications → Seedlings → Allow Notifications."
                  : /Android/.test(navigator.userAgent || "")
                    ? " long-press the Seedlings icon → App info → Notifications → On."
                    : " click the lock icon in your address bar and allow notifications, or remove the block in your browser's site settings."}
              </Text>
            </Box>
          )}

          {(push.status === "default" || push.status === "granted-no-sub") && (
            <VStack align="stretch" gap={2}>
              <HStack justify="space-between" align="center">
                <Text fontSize="xs" color="fg.muted">
                  Get a push notification on this device for daily plan reminders.
                </Text>
                <Button
                  size="xs"
                  colorPalette="blue"
                  loading={push.busy}
                  onClick={async () => {
                    const r = await push.subscribe();
                    if (r.ok) publishInlineMessage({ type: "SUCCESS", text: "Notifications enabled. If you don't see them, check Settings → Notifications on your device." });
                    else publishInlineMessage({ type: "ERROR", text: r.error ?? "Could not enable" });
                  }}
                >
                  Enable on this device
                </Button>
              </HStack>
              {bannerDismissed && (
                <HStack justify="space-between" align="center">
                  <Text fontSize="xs" color="fg.muted">
                    You dismissed the enable-notifications reminder.
                  </Text>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      try { localStorage.removeItem("seedlings_pushBannerDismissed"); } catch {}
                      setBannerDismissed(false);
                      publishInlineMessage({ type: "SUCCESS", text: "Reminder will show again on the Home + Jobs-Next tabs." });
                    }}
                  >
                    Show reminder again
                  </Button>
                </HStack>
              )}
            </VStack>
          )}

          {push.status === "granted" && (
            <VStack align="stretch" gap={2}>
              <Text fontSize="xs" color="fg.muted">
                Notifications are on. You'll get a push for each daily plan reminder.
              </Text>
              <Box p={2} bg="yellow.faint" borderWidth="1px" borderColor="yellow.emphasized" rounded="md">
                <Text fontSize="xs" color="yellow.fg">
                  If you don't see notifications, check Settings → Notifications and verify it's enabled for your browser (e.g. Chrome, Safari, etc.).
                </Text>
              </Box>
            </VStack>
          )}

          {push.devices.length > 0 && (
            <VStack align="stretch" gap={2}>
              {push.devices.map((d) => {
                const isThis = !!thisEndpoint && d.endpoint === thisEndpoint;
                return (
                  <Box key={d.id} p={2} borderWidth="1px" borderRadius="md" fontSize="xs">
                    <HStack justify="space-between" align="start">
                      <VStack align="start" gap={0.5} flex="1" minW={0}>
                        <HStack gap={2}>
                          <Text fontWeight="medium">{deviceLabel(d.userAgent, d.label)}</Text>
                          {isThis && <Badge size="sm" colorPalette="blue">This device</Badge>}
                        </HStack>
                        <Text color="fg.muted">Added: {fmtDateLong(d.createdAt)}</Text>
                        {d.lastUsedAt && <Text color="fg.muted">Last used: {fmtDateLong(d.lastUsedAt)}</Text>}
                      </VStack>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        loading={push.busy}
                        onClick={async () => {
                          await push.removeDevice(d.id);
                          publishInlineMessage({ type: "SUCCESS", text: "Device removed." });
                        }}
                      >
                        Remove
                      </Button>
                    </HStack>
                  </Box>
                );
              })}
            </VStack>
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function CalendarFeedsSection() {
  type FeedToken = { id: string; label?: string | null; token: string; filters: any; createdAt: string; lastAccessedAt?: string | null };
  const [feeds, setFeeds] = useState<FeedToken[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const list = await apiGet<FeedToken[]>("/api/calendar-feeds");
      setFeeds(Array.isArray(list) ? list : []);
    } catch {}
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function revoke(id: string) {
    try {
      await apiDelete(`/api/calendar-feeds/${id}`);
      setFeeds((prev) => prev.filter((f) => f.id !== id));
      publishInlineMessage({ type: "SUCCESS", text: "Feed revoked." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Revoke failed.", err) });
    }
  }

  async function revokeAll() {
    for (const f of feeds) {
      await apiDelete(`/api/calendar-feeds/${f.id}`).catch(() => {});
    }
    setFeeds([]);
    publishInlineMessage({ type: "SUCCESS", text: "All feeds revoked." });
  }


  const filterSummary = (f: any) => {
    const parts: string[] = [];
    if (f?.kind && f.kind !== "ALL") parts.push(f.kind);
    if (f?.statusFilter && f.statusFilter !== "ALL") parts.push(f.statusFilter);
    if (f?.typeFilter && f.typeFilter !== "ALL") parts.push(f.typeFilter);
    if (f?.vipOnly) parts.push("VIP");
    if (f?.likedOnly) parts.push("Liked");
    return parts.length > 0 ? parts.join(", ") : "All jobs";
  };

  return (
    <Card.Root variant="outline" mt={4}>
      <Card.Header py="2" px="3" pb="0">
        <HStack justify="space-between" align="center">
          <Text fontWeight="semibold">Calendar Feeds</Text>
          {feeds.length > 1 && (
            <Button size="xs" variant="ghost" colorPalette="red" onClick={revokeAll}>
              Revoke All
            </Button>
          )}
        </HStack>
      </Card.Header>
      <Card.Body py="2" px="3">
        {loading ? (
          <Spinner size="sm" />
        ) : feeds.length === 0 ? (
          <Text fontSize="xs" color="fg.muted">No active calendar feeds. Create one from the Jobs tab using the calendar icon.</Text>
        ) : (
          <VStack align="stretch" gap={2}>
            {feeds.map((f) => (
              <Box key={f.id} p={2} borderWidth="1px" borderRadius="md" fontSize="xs">
                <HStack justify="space-between" align="start">
                  <VStack align="start" gap={0.5} flex="1" minW={0}>
                    <Text fontWeight="medium">{f.label || "Calendar Feed"}</Text>
                    <Text color="fg.muted">Filters: {filterSummary(f.filters)}</Text>
                    <Text color="fg.muted">Created: {fmtDateLong(f.createdAt)}</Text>
                    {f.lastAccessedAt && (
                      <Text color="fg.muted">Last polled: {fmtDateLong(f.lastAccessedAt)}</Text>
                    )}
                    {!f.lastAccessedAt && (
                      <Text color="orange.fg">Never accessed</Text>
                    )}
                  </VStack>
                  <Button size="xs" variant="outline" colorPalette="red" onClick={() => revoke(f.id)}>
                    Revoke
                  </Button>
                </HStack>
              </Box>
            ))}
          </VStack>
        )}
      </Card.Body>
    </Card.Root>
  );
}

function OfflineSection() {
  const { isOffline, isForceOffline, setForceOffline, lastSyncedAt } = useOffline();
  const [queuedActions, setQueuedActions] = useState<QueuedAction[]>([]);

  useEffect(() => {
    void getAllActions().then(setQueuedActions);
    return subscribeQueue(() => void getAllActions().then(setQueuedActions));
  }, []);

  return (
    <Card.Root variant="outline" mt={4}>
      <Card.Header py="2" px="3" pb="0">
        <HStack justify="space-between" align="center">
          <Text fontWeight="semibold">Connection</Text>
          <HStack gap={2} align="center">
            <Box
              w="10px"
              h="10px"
              borderRadius="full"
              bg={isOffline ? (isForceOffline ? "orange.strong" : "red.strong") : "green.strong"}
            />
            <Text fontSize="xs" color="fg.muted">
              {isOffline ? (isForceOffline ? "Force offline" : "Offline") : "Online"}
            </Text>
          </HStack>
        </HStack>
      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={3}>
          <HStack justify="space-between" align="center">
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="medium">Force Offline Mode</Text>
              <Text fontSize="xs" color="fg.muted">When enabled, all data is served from cache. Actions are disabled until you go back online.</Text>
            </VStack>
            <Button
              size="sm"
              variant={isForceOffline ? "solid" : "outline"}
              colorPalette={isForceOffline ? "orange" : "gray"}
              onClick={() => setForceOffline(!isForceOffline)}
            >
              {isForceOffline ? "On" : "Off"}
            </Button>
          </HStack>
          {lastSyncedAt && (
            <Text fontSize="xs" color="fg.muted">
              Last synced: {fmtTimeOpts(lastSyncedAt, { hour: "numeric", minute: "2-digit", second: "2-digit" })}
            </Text>
          )}
          {queuedActions.length > 0 && (
            <Box>
              <HStack justify="space-between" align="center" mb={2}>
                <Text fontSize="sm" fontWeight="medium">
                  Pending Actions ({queuedActions.filter((a) => a.status === "pending" || a.status === "failed").length})
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  colorPalette="red"
                  onClick={async () => { await clearAllActions(); void getAllActions().then(setQueuedActions); }}
                >
                  Clear All
                </Button>
              </HStack>
              <VStack align="stretch" gap={1}>
                {queuedActions.filter((a) => a.status !== "synced").map((a) => (
                  <HStack
                    key={a.id}
                    px={2}
                    py={1}
                    borderWidth="1px"
                    borderColor={a.status === "failed" ? "red.emphasized" : "gray.emphasized"}
                    bg={a.status === "failed" ? "red.faint" : undefined}
                    rounded="md"
                    justify="space-between"
                    fontSize="xs"
                  >
                    <VStack align="start" gap={0}>
                      <Text fontWeight="medium">
                        {a.status === "pending" ? "⏳" : a.status === "failed" ? "❌" : "🔄"} {a.label}
                      </Text>
                      {a.error && <Text color="red.fg">{a.error}</Text>}
                    </VStack>
                    <HStack gap={1}>
                      {a.status === "failed" && (
                        <Button size="xs" variant="ghost" px="1" minW="0" onClick={async () => { await retryAction(a.id); void getAllActions().then(setQueuedActions); }}>
                          ↻
                        </Button>
                      )}
                      {(a.status === "pending" || a.status === "failed") && (
                        <Button size="xs" variant="ghost" colorPalette="red" px="1" minW="0" onClick={async () => { await deleteAction(a.id); void getAllActions().then(setQueuedActions); }}>
                          ✕
                        </Button>
                      )}
                    </HStack>
                  </HStack>
                ))}
              </VStack>
            </Box>
          )}
          <HStack justify="space-between" align="center">
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="medium">Clear Cache</Text>
              <Text fontSize="xs" color="fg.muted">Remove all locally cached data and reload. Use if data seems stale or incorrect.</Text>
            </VStack>
            <Button
              size="sm"
              variant="outline"
              colorPalette="red"
              onClick={async () => {
                try {
                  // Clear service worker caches
                  const keys = await caches.keys();
                  await Promise.all(keys.map((k) => caches.delete(k)));
                  // Unregister service worker
                  const regs = await navigator.serviceWorker?.getRegistrations();
                  if (regs) await Promise.all(regs.map((r) => r.unregister()));
                  publishInlineMessage({ type: "SUCCESS", text: "Cache cleared. Reloading..." });
                  setTimeout(() => window.location.reload(), 500);
                } catch {
                  publishInlineMessage({ type: "ERROR", text: "Failed to clear cache." });
                }
              }}
            >
              Clear
            </Button>
          </HStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}


/**
 * Appearance — the five themes. Sits above SeasonSection because it can
 * OVERRIDE it: Spring and Fall are a season as well as a palette.
 */
function ThemeSection() {
  const { theme, setTheme } = useAppTheme();
  return (
    <Card.Root variant="outline" mt={4}>
      <Card.Header py="2" px="3" pb="0">
        <Text fontWeight="semibold">Appearance</Text>
      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={2}>
          <Text fontSize="xs" color="fg.muted">
            Changes how the whole app looks on this device. Nothing is shared
            with your clients — pages they see keep the standard look.
          </Text>
          <VStack align="stretch" gap={1.5}>
            {THEME_IDS.map((id) => {
              const active = theme === id;
              return (
                <Box
                  key={id}
                  as="button"
                  data-testid={`theme-option-${id}`}
                  data-active={active ? "true" : "false"}
                  textAlign="left"
                  px={3}
                  py={2}
                  borderWidth="1px"
                  borderRadius="lg"
                  cursor="pointer"
                  borderColor={active ? "accent.solid" : "border.default"}
                  bg={active ? "accent.muted" : "surface.panel"}
                  onClick={() => setTheme(id)}
                >
                  <HStack gap={2} align="center">
                    {/* The palette itself — the fastest way to judge a theme
                        is to see its colours, not read its name. */}
                    <HStack gap={0.5} flexShrink={0}>
                      {(["surface.page", "chrome.header", "accent.solid"] as const).map((k) => (
                        <Box
                          key={k}
                          w="14px"
                          h="14px"
                          borderRadius="3px"
                          borderWidth="1px"
                          borderColor="border.emphasis"
                          style={{ background: SURFACES[id][k] }}
                        />
                      ))}
                    </HStack>
                    <Box flex="1" minW={0}>
                      <Text fontSize="sm" fontWeight={active ? "semibold" : "medium"}>
                        {THEME_LABELS[id]}
                      </Text>
                      <Text fontSize="2xs" color="fg.muted">{THEME_DESCRIPTIONS[id]}</Text>
                    </Box>
                    {active && <Check size={16} />}
                  </HStack>
                </Box>
              );
            })}
          </VStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

function SeasonSection() {
  const [override, setOverride] = useState<SeasonOverride>(getSeasonOverride());
  const natural = getNaturalSeason();

  function handleChange(value: SeasonOverride) {
    setSeasonOverride(value);
    setOverride(value);
    window.dispatchEvent(new CustomEvent("seedlings:seasonChanged"));
  }

  return (
    <Card.Root variant="outline" mt={4}>
      <Card.Header py="2" px="3" pb="0">
        <Text fontWeight="semibold">Season Theme</Text>

      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={3}>
          <Text fontSize="xs" color="fg.muted">
            The app icon changes with the seasons. Spring/Summer (Mar–Aug) uses the green icon, Fall/Winter (Sep–Feb) uses the fall icon. You can override this for your experience.
          </Text>
          <HStack gap={2}>
            {(["auto", "spring", "fall"] as const).map((val) => (
              <Button
                key={val}
                size="sm"
                variant={override === val ? "solid" : "outline"}
                colorPalette={val === "auto" ? "gray" : val === "spring" ? "green" : "orange"}
                onClick={() => handleChange(val)}
              >
                {val === "auto" ? `Auto (${natural === "spring" ? "Spring" : "Fall"})` : val === "spring" ? "Spring" : "Fall"}
              </Button>
            ))}
          </HStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}

type EarningsSummary = {
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  allTime: number;
  jobCount: number;
  byMethod: Record<string, number>;
};

function EarningsSection({ targetUserId, isSelf }: { targetUserId: string; isSelf: boolean }) {
  const [data, setData] = useState<EarningsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!targetUserId) { setLoading(false); return; }
    setLoading(true);
    const endpoint = isSelf ? "/api/payments/earnings-summary" : `/api/users/${targetUserId}/earnings-summary`;
    apiGet<EarningsSummary>(endpoint)
      .then((d) => setData(d))
      // Still tolerant, but no longer the ONLY gate: the caller checks
      // `payroll.view` before mounting this. What reaches here is a real
      // failure — a worker with no payment history reads the same as a
      // network error, which is why the capability check moved out.
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [targetUserId, isSelf]);

  if (loading) return null;
  if (!data) return null;

  const fmt = (v: number) => `$${v.toFixed(2)}`;
  const methodLabel = (m: string) => {
    const map: Record<string, string> = { CASH: "Cash", CHECK: "Check", VENMO: "Venmo", ZELLE: "Zelle", APPLE_PAY: "Apple Pay", CASH_APP: "Cash App", OTHER: "Other" };
    return map[m] ?? m;
  };

  return (
    <Card.Root variant="outline">
      <Card.Header py="2" px="3" pb="0">
        <HStack justify="space-between" alignItems="center">
          <Text fontWeight="semibold">Earnings</Text>
          {isSelf && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("navigate:staffTab", { detail: { tab: "payments", category: "Money" } }));
              }}
            >
              View Payments →
            </Button>
          )}
        </HStack>
      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={3}>
          <HStack gap={4} wrap="wrap">
            <VStack align="start" gap={0}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Week</Text>
              <Text fontSize="lg" fontWeight="bold" color="green.fg">{fmt(data.thisWeek)}</Text>
            </VStack>
            <VStack align="start" gap={0}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Month</Text>
              <Text fontSize="lg" fontWeight="bold" color="green.fg">{fmt(data.thisMonth)}</Text>
            </VStack>
            <VStack align="start" gap={0}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Year</Text>
              <Text fontSize="lg" fontWeight="bold" color="green.fg">{fmt(data.thisYear)}</Text>
            </VStack>
            <VStack align="start" gap={0}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">All Time</Text>
              <Text fontSize="lg" fontWeight="bold">{fmt(data.allTime)}</Text>
            </VStack>
          </HStack>
          <HStack gap={2} wrap="wrap">
            <Text fontSize="xs" color="fg.muted">{data.jobCount} job{data.jobCount !== 1 ? "s" : ""} total</Text>
            {Object.entries(data.byMethod).length > 0 && (
              <>
                <Text fontSize="xs" color="fg.muted">·</Text>
                {Object.entries(data.byMethod).map(([method, amount]) => (
                  <Badge key={method} size="sm" variant="subtle" colorPalette="gray">
                    {methodLabel(method)}: {fmt(amount)}
                  </Badge>
                ))}
              </>
            )}
          </HStack>
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
