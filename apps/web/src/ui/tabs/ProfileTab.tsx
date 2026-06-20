"use client";

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
import { X } from "lucide-react";
import AddressAutocomplete from "@/src/ui/components/AddressAutocomplete";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { type Me, type Role } from "@/src/lib/types";
import { fmtDate as fmtDateLib, fmtDateOpts, fmtTimeOpts, bizToday, bizDateKey, bizDaysBetween } from "@/src/lib/lib";
import { useOffline } from "@/src/lib/offline";
import { getAllActions, deleteAction, retryAction, clearAllActions, subscribeQueue, type QueuedAction } from "@/src/lib/offlineQueue";
import { usePushNotifications } from "@/src/lib/usePushNotifications";
import { getSeasonOverride, setSeasonOverride, getNaturalSeason, type SeasonOverride } from "@/src/lib/season";
import {
  getImpersonation,
  setImpersonation,
  IMPERSONATION_LABELS,
  IMPERSONATION_OPTIONS,
  type ImpersonationValue,
} from "@/src/lib/impersonation";
import { useClerk } from "@clerk/clerk-react";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type Worker = { id: string; displayName?: string | null; email?: string | null; workerType?: string | null };

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
   * When true, this is the Admin or Super Profile tab (shows user selector, no self-only sections).
   * When false/omitted, this is the Worker Profile tab (always shows own profile).
   *
   * NOTE: This prop controls which TAB context we're in, NOT the user's role.
   * To check if the current user has admin privileges, use `me?.roles?.includes("ADMIN")`.
   * Use `isAdmin` (prop) for: user selector, save endpoint routing, tab-level layout.
   * Use `me?.roles` for: feature gating (e.g., season override is admin-only regardless of tab).
   * Use `isSelf` for: self-only features (calendar feeds, offline, season) that only make
   *   sense when viewing your own profile.
   */
  isAdmin?: boolean;
  /**
   * Which tab the user navigated into to land here. Distinguishes the Admin
   * Profile tab from the Super Profile tab so we can gate Super-only edits
   * (e.g., payment-comms override) to the Super tab — even if the current
   * user happens to be a Super viewing the Admin tab.
   */
  purpose?: Role;
  onProfileUpdated?: () => void;
};

export default function ProfileTab({ me, isAdmin, purpose, onProfileUpdated }: Props) {
  // Admin: user selector
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
  // Hourly wage — admin-only field; used by the Reconcile → Payroll
  // export to compute regular wages vs additional earnings.
  const [hourlyWage, setHourlyWage] = useState("0.00");
  const [savedHourlyWage, setSavedHourlyWage] = useState("0.00");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  // Payment comms mode — the target user's per-profile override (null = use org default)
  // plus the org-wide default fetched from /api/settings.
  const [commsMode, setCommsMode] = useState<"SERVER" | "CLAIMER" | null>(null);
  const [orgCommsMode, setOrgCommsMode] = useState<"SERVER" | "CLAIMER">("CLAIMER");
  const [commsBusy, setCommsBusy] = useState(false);

  // Super-only edits (payment-comms override, etc.) require BOTH the SUPER
  // role AND being on the Super Profile tab. A Super viewing the Admin Profile
  // tab sees the same read-only summary that an Admin would.
  const isSuper = !!me?.roles?.includes("SUPER") && purpose === "SUPER";

  const phoneError = phone.trim() !== "" && normalizePhone(phone) === null;

  // Hourly wage only counts toward unsaved-changes when the viewer is
  // a SUPER — non-super viewers see it read-only and the input is
  // disabled.
  const hourlyWageChanged = isSuper && hourlyWage !== savedHourlyWage;
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
  const targetUserId = isAdmin ? (selectedUserId || "") : (me?.id ?? "");
  const isSelf = !!targetUserId && targetUserId === me?.id;

  // Load workers list for admin
  useEffect(() => {
    if (!isAdmin) return;
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [isAdmin]);

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
    apiGet<any>(`/api/admin/users/${targetUserId}`)
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
      await apiPatch(`/api/admin/users/${targetUserId}/payment-comms-mode`, { mode: target });
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
      const endpoint = isAdmin && !isSelf
        ? `/api/admin/users/${targetUserId}/profile`
        : "/api/me/profile";
      const normPhone = phone.trim() ? normalizePhone(phone) : null;
      // hourlyWage is admin-only — only include it in the payload when
      // an admin is the one editing (avoid sending an irrelevant field
      // from /api/me/profile where it would be rejected).
      const payload: any = {
        firstName,
        lastName,
        displayName,
        phone: normPhone,
        homeBaseAddress: homeBase,
        availableDays,
        availableHoursPerDay: availableHours,
      };
      // hourlyWage is SUPER-only on the write side. Only include it
      // when the viewer is on the Super Profile tab with the SUPER
      // role — the server enforces the same gate independently.
      if (isSuper) {
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

  const workerTypeLabel = (wt: string | null | undefined) =>
    wt === "EMPLOYEE" ? "W-2 Employee" : wt === "CONTRACTOR" ? "1099 Contractor" : wt === "TRAINEE" ? "Trainee" : "Unclassified";

  return (
    <Box w="full" pb={8}>
      {/* Admin: user selector */}
      {isAdmin && (
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
                    bg={selectedUserId === w.id ? "blue.50" : undefined}
                    _hover={{ bg: "gray.100" }}
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

      {isAdmin && !targetUserId ? (
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
                      borderColor={phoneError ? "red.400" : undefined}
                    />
                    {phoneError ? (
                      <Text fontSize="xs" color="red.500" mt="0.5">Enter a valid 10-digit US phone number.</Text>
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
                      : targetUser?.workerType === "TRAINEE" ? "cyan"
                      : "gray"
                    }
                  >
                    {workerTypeLabel(targetUser?.workerType)}
                  </Badge>
                </HStack>
                {/* Self-view only: contractor's guaranteed payout period.
                    During the window, the contractor is paid for completed
                    work regardless of client payment timing. Only renders
                    while the period is active. */}
                {isSelf && me?.workerType === "CONTRACTOR" && me?.guaranteedPayoutUntil && (() => {
                  const untilDate = new Date(me.guaranteedPayoutUntil);
                  const active = untilDate.getTime() > Date.now();
                  if (!active) return null;
                  // ET calendar-day diff (not raw ms / 86_400_000 which
                  // drifts at DST). See bizDaysBetween in lib/lib.ts.
                  const daysLeft = Math.max(0, bizDaysBetween(bizToday(), bizDateKey(untilDate)));
                  return (
                    <HStack fontSize="sm" align="flex-start">
                      <Text color="fg.muted" w="80px">Payout:</Text>
                      <Box flex="1">
                        <Badge colorPalette={daysLeft <= 7 ? "yellow" : "purple"} variant="solid">
                          Guaranteed through {fmtDateLib(me.guaranteedPayoutUntil)} · {daysLeft}d left
                        </Badge>
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          During this onboarding window you're paid for each completed job on the
                          next contractor payroll run for the week the work fell in — same timing
                          a W-2 employee would see for that work. After {fmtDateLib(me.guaranteedPayoutUntil)},
                          the standing contingent-payment terms in your Independent Contractor
                          Agreement apply (paid after the client pays).
                        </Text>
                      </Box>
                    </HStack>
                  );
                })()}
                {isSelf && (
                  <Box pt={2} borderTopWidth="1px" borderColor="gray.200">
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

          {/* Permissions card — self-view only (admins manage other users'
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
                        fees, etc.). Without this privilege, ask an admin to log out-of-pocket
                        purchases for you.
                      </Text>
                    </Box>
                    <Badge colorPalette={me.privileges.canChargeBusinessExpenses ? "green" : "gray"}>
                      {me.privileges.canChargeBusinessExpenses ? "Enabled" : "Not enabled"}
                    </Badge>
                  </HStack>
                  {!me.privileges.canPullInventory && !me.privileges.canChargeBusinessExpenses && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Job expenses are recorded by an admin on your behalf. Reach out to your admin
                      if anything needs to be logged.
                    </Text>
                  )}
                </VStack>
              </Card.Body>
            </Card.Root>
          )}

          {/* Payment comms — how this user's payment-request messages get sent.
              All users can see the effective value; only Super can change the
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
                    {isSuper && (
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
              rate on file). Editable only by a SUPER on the Super
              Profile tab; the server enforces the same gate via
              `req.user.roles.includes("SUPER")`. Drives the
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
                  {isSuper
                    ? "Used by Reconcile → Payroll. For employees/trainees, this is the rate Gusto auto-applies to logged hours. Contractors typically leave this at $0 (paid lump-sum via Additional Earnings)."
                    : isSelf
                      ? "Your hourly rate on file. Only a Super admin can update this."
                      : "Hourly rate on file. Only a Super admin can update this."}
                </Text>
                <HStack gap={2} align="center">
                  <Text fontSize="sm" fontWeight="semibold">$</Text>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={hourlyWage}
                    disabled={!isSuper}
                    onChange={(e) => setHourlyWage(e.target.value)}
                    onBlur={() => {
                      const n = Number(hourlyWage);
                      setHourlyWage(Number.isFinite(n) && n >= 0 ? n.toFixed(2) : "0.00");
                    }}
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      border: "1px solid var(--chakra-colors-border-default)",
                      borderRadius: "4px",
                      fontSize: "14px",
                      background: isSuper ? undefined : "var(--chakra-colors-gray-100)",
                      color: isSuper ? undefined : "var(--chakra-colors-fg-muted)",
                      cursor: isSuper ? "text" : "not-allowed",
                    }}
                  />
                  <Text fontSize="sm" color="fg.muted">/hr</Text>
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Unsaved changes warning */}
          {hasChanges && (
            <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
              <Text fontSize="xs" color="yellow.700">You have unsaved changes.</Text>
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

          {/* Earnings — visible when viewing own profile or admin viewing a worker */}
          <EarningsSection targetUserId={targetUserId} isSelf={isSelf} />

          {/* Self-only sections — shown on any tab when viewing your own profile.
              Gate on `isSelf` for features any user gets.
              Gate on `isSelf && me?.roles?.includes(...)` for role-restricted features. */}
          {isSelf && <NotificationsSection />}
          {isSelf && <CalendarFeedsSection />}
          {isSelf && <OfflineSection />}
          {isSelf && me?.roles?.includes("ADMIN") && <SeasonSection />}
          {/* View-as picker is gated on REAL Super — must be visible even
              while impersonating so Super can switch back without having
              to use the persistent banner. */}
          {isSelf && me?.realRoles?.includes("SUPER") && <ImpersonationSection />}
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

  const fmtDate = (s?: string | null) =>
    s ? fmtDateOpts(s, { month: "short", day: "numeric", year: "numeric" }) : "";

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
            <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
              <Text fontSize="xs" color="yellow.800">
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
                    You dismissed the reminder on the Home tab.
                  </Text>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      try { localStorage.removeItem("seedlings_pushBannerDismissed"); } catch {}
                      setBannerDismissed(false);
                      publishInlineMessage({ type: "SUCCESS", text: "Reminder will show on the Home tab again." });
                    }}
                  >
                    Show on Home
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
              <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
                <Text fontSize="xs" color="yellow.800">
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
                        <Text color="fg.muted">Added: {fmtDate(d.createdAt)}</Text>
                        {d.lastUsedAt && <Text color="fg.muted">Last used: {fmtDate(d.lastUsedAt)}</Text>}
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

  const fmtDate = (s: string) =>
    fmtDateOpts(s, { month: "short", day: "numeric", year: "numeric" });

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
                    <Text color="fg.muted">Created: {fmtDate(f.createdAt)}</Text>
                    {f.lastAccessedAt && (
                      <Text color="fg.muted">Last polled: {fmtDate(f.lastAccessedAt)}</Text>
                    )}
                    {!f.lastAccessedAt && (
                      <Text color="orange.500">Never accessed</Text>
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
              bg={isOffline ? (isForceOffline ? "orange.400" : "red.400") : "green.400"}
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
                    borderColor={a.status === "failed" ? "red.200" : "gray.200"}
                    bg={a.status === "failed" ? "red.50" : undefined}
                    rounded="md"
                    justify="space-between"
                    fontSize="xs"
                  >
                    <VStack align="start" gap={0}>
                      <Text fontWeight="medium">
                        {a.status === "pending" ? "⏳" : a.status === "failed" ? "❌" : "🔄"} {a.label}
                      </Text>
                      {a.error && <Text color="red.600">{a.error}</Text>}
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

// Super-only "View as another role" section. Gated at the call site on
// me.realRoles.includes("SUPER") so it stays visible even while
// impersonation is active. Reads the current selection from localStorage
// (NOT from `me`) so the picker reflects the active token even if the
// page hasn't reloaded yet. Toggling reloads the page and purges the SW
// cache via setImpersonation().
function ImpersonationSection() {
  const [current, setCurrent] = useState<ImpersonationValue | null>(() => getImpersonation());
  const [detailsOpen, setDetailsOpen] = useState(false);

  function pick(next: ImpersonationValue | null) {
    setCurrent(next);
    void setImpersonation(next); // reloads page
  }

  return (
    <Card.Root variant="outline" mt={4} borderColor="red.300">
      <Card.Header py="2" px="3" pb="0">
        <Text fontWeight="semibold">🛡 View as another role (Super only)</Text>
      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={3}>
          <Text fontSize="sm" color="fg.muted">
            Temporarily change your effective role so your UI and the backend's
            authorization both act like you're a different role. Use this to
            catch role-conditioning bugs before they hit real users.
          </Text>
          <Box>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setDetailsOpen((v) => !v)}
            >
              {detailsOpen ? "Hide details ↑" : "Show details ↓"}
            </Button>
          </Box>
          {detailsOpen && (
            <Box
              p={3}
              bg="blue.50"
              borderWidth="1px"
              borderColor="blue.300"
              borderLeftWidth="4px"
              borderLeftColor="blue.500"
              rounded="md"
            >
              <VStack align="stretch" gap={3} fontSize="sm" color="blue.900">
                <Box>
                  <Text fontWeight="semibold" mb={1}>What changes</Text>
                  <Text>When you pick a role here, the following behave as if you had only that role:</Text>
                  <VStack as="ul" align="stretch" gap={1} pl={4} mt={1}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">UI conditionals</Text> — every gate that branches on role / workerType (Confirm Client, Start Job, observer eye, Admin tab visibility, claim flow, tile visibility, etc.) renders the impersonated view.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Backend authorization</Text> — <Text as="code" fontFamily="mono">requireRole(...)</Text> on every protected route checks the impersonated role. Admin-only endpoints return real 403s to you, exactly like they would to an actual worker. "Looks fine on my screen" no longer differs from "actually works for them".
                    </Text>
                  </VStack>
                </Box>
                <Box>
                  <Text fontWeight="semibold" mb={1}>What stays the same</Text>
                  <VStack as="ul" align="stretch" gap={1} pl={4}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Your identity.</Text> User ID, name, email, and Clerk session are unchanged.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Your data.</Text> "My jobs / my expenses / my assignments" still return your records, just rendered through the impersonated role's UI. You are NOT "logging in as Bob" — you are "seeing your own world as if your role were different".
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Audit log attribution.</Text> Any mutation you perform while impersonating is recorded as Super performing it. The database is never confused about who really acted.
                    </Text>
                  </VStack>
                </Box>
                <Box>
                  <Text fontWeight="semibold" mb={1}>Things to be careful about</Text>
                  <VStack as="ul" align="stretch" gap={1} pl={4}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mutations are real.</Text> If the impersonated UI shows a button and you tap it, the server runs the action. Reduced UI ≠ reduced consequences. Be especially careful with delete / archive / payment actions.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Bugs that depend on a specific user's data shape won't surface.</Text> Example: "what does a worker with zero assignments see?" — you'll see your assignments through their role lens, not the empty state they hit. For those, use a real test login.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Toggling reloads the page</Text> to flush in-flight requests and the Service Worker cache. Close any open dialogs first so you don't lose typed-in input.
                    </Text>
                  </VStack>
                </Box>
                <Box>
                  <Text fontWeight="semibold" mb={1}>How to exit</Text>
                  <VStack as="ul" align="stretch" gap={1} pl={4}>
                    <Text as="li">
                      A red banner at the top of every page has an <Text as="span" fontWeight="semibold">Exit impersonation</Text> button — always visible while a role override is active.
                    </Text>
                    <Text as="li">
                      Or return here and pick <Text as="span" fontWeight="semibold">Super (default)</Text>.
                    </Text>
                  </VStack>
                </Box>
              </VStack>
            </Box>
          )}
          <HStack gap={2} wrap="wrap">
            <Button
              size="sm"
              variant={current === null ? "solid" : "outline"}
              colorPalette="gray"
              onClick={() => pick(null)}
            >
              Super (default)
            </Button>
            {IMPERSONATION_OPTIONS.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant={current === opt ? "solid" : "outline"}
                colorPalette="red"
                onClick={() => pick(opt)}
              >
                {IMPERSONATION_LABELS[opt]}
              </Button>
            ))}
          </HStack>
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
    const endpoint = isSelf ? "/api/payments/earnings-summary" : `/api/admin/users/${targetUserId}/earnings-summary`;
    apiGet<EarningsSummary>(endpoint)
      .then((d) => setData(d))
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
                window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "payments", category: "Money" } }));
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
              <Text fontSize="lg" fontWeight="bold" color="green.600">{fmt(data.thisWeek)}</Text>
            </VStack>
            <VStack align="start" gap={0}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Month</Text>
              <Text fontSize="lg" fontWeight="bold" color="green.600">{fmt(data.thisMonth)}</Text>
            </VStack>
            <VStack align="start" gap={0}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Year</Text>
              <Text fontSize="lg" fontWeight="bold" color="green.600">{fmt(data.thisYear)}</Text>
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
