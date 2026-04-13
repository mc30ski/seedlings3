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
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { type Me } from "@/src/lib/types";

type Worker = { id: string; displayName?: string | null; email?: string | null; workerType?: string | null };

type Props = {
  me: Me | null;
  /** When true, shows admin controls (user selector) */
  isAdmin?: boolean;
  onProfileUpdated?: () => void;
};

export default function ProfileTab({ me, isAdmin, onProfileUpdated }: Props) {
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
  const [homeBase, setHomeBase] = useState("");
  const [savedHomeBase, setSavedHomeBase] = useState("");
  const [availableDays, setAvailableDays] = useState<number[]>([]);
  const [savedAvailableDays, setSavedAvailableDays] = useState<number[]>([]);
  const [availableHours, setAvailableHours] = useState(4);
  const [savedAvailableHours, setSavedAvailableHours] = useState(4);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const hasChanges = firstName !== savedFirstName ||
    lastName !== savedLastName ||
    displayName !== savedDisplayName ||
    homeBase !== savedHomeBase ||
    JSON.stringify(availableDays) !== JSON.stringify(savedAvailableDays) ||
    availableHours !== savedAvailableHours;

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

  // The user we're viewing — admin can switch, worker is always self
  const targetUserId = isAdmin && selectedUserId ? selectedUserId : me?.id ?? "";
  const isSelf = targetUserId === me?.id;

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
      if (userId && userId !== me?.id) {
        setSelectedUserId(userId);
      } else {
        setSelectedUserId("");
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
      setHomeBase(me.homeBaseAddress ?? ""); setSavedHomeBase(me.homeBaseAddress ?? "");
      setAvailableDays(me.availableDays ?? []); setSavedAvailableDays(me.availableDays ?? []);
      setAvailableHours(me.availableHoursPerDay ?? 4); setSavedAvailableHours(me.availableHoursPerDay ?? 4);
      return;
    }
    // Admin viewing another user — fetch their data
    setLoading(true);
    apiGet<any>(`/api/admin/users/${targetUserId}`)
      .then((u) => {
        setFirstName(u?.firstName ?? ""); setSavedFirstName(u?.firstName ?? "");
        setLastName(u?.lastName ?? ""); setSavedLastName(u?.lastName ?? "");
        setDisplayName(u?.displayName ?? ""); setSavedDisplayName(u?.displayName ?? "");
        setHomeBase(u?.homeBaseAddress ?? ""); setSavedHomeBase(u?.homeBaseAddress ?? "");
        const days = u?.availableDays ? (Array.isArray(u.availableDays) ? u.availableDays : JSON.parse(u.availableDays)) : [];
        setAvailableDays(days); setSavedAvailableDays(days);
        const hours = u?.availableHoursPerDay ?? 4;
        setAvailableHours(hours);
        setSavedAvailableHours(hours);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [targetUserId, isSelf, me]);

  async function saveProfile() {
    setSaving(true);
    try {
      const endpoint = isAdmin && !isSelf
        ? `/api/admin/users/${targetUserId}/profile`
        : "/api/me/profile";
      await apiPatch(endpoint, {
        firstName,
        lastName,
        displayName,
        homeBaseAddress: homeBase,
        availableDays,
        availableHoursPerDay: availableHours,
      });
      setSavedFirstName(firstName);
      setSavedLastName(lastName);
      setSavedDisplayName(displayName);
      setSavedHomeBase(homeBase);
      setSavedAvailableDays([...availableDays]);
      setSavedAvailableHours(availableHours);
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
    ? { displayName: me?.displayName, email: me?.email, phone: me?.phone, workerType: me?.workerType }
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
              placeholder={selectedUserId ? (workerNameMap[selectedUserId] || selectedUserId) : me?.displayName ?? "You"}
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
                {/* Self option */}
                <Box
                  px={3} py={1.5} cursor="pointer" fontSize="sm"
                  bg={!selectedUserId ? "blue.50" : undefined}
                  _hover={{ bg: "gray.100" }}
                  onClick={() => { setSelectedUserId(""); setDropOpen(false); setSearchText(""); }}
                >
                  <Text fontWeight="medium">{me?.displayName ?? me?.email ?? "You"} (me)</Text>
                </Box>
                {limited.filter((w) => w.id !== me?.id).map((w) => (
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

      {loading ? (
        <Box py={10} textAlign="center"><Spinner size="lg" /></Box>
      ) : (
        <VStack align="stretch" gap={4} w="full">
          {/* Name & info card */}
          <Card.Root variant="outline">
            <Card.Header py="3" px="4" pb="0">
              <HStack justify="space-between" align="center">
                <Text fontWeight="semibold">Personal Information</Text>
                {isSelf && (
                  <VStack align="end" gap={0.5}>
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="blue"
                      onClick={async () => {
                        try {
                          await apiPost("/api/me/sync");
                          onProfileUpdated?.();
                          publishInlineMessage({ type: "SUCCESS", text: "Profile synced from Clerk." });
                        } catch (e) {
                          publishInlineMessage({ type: "ERROR", text: getErrorMessage(e) });
                        }
                      }}
                    >
                      Sync Authentication
                    </Button>
                    <Text fontSize="2xs" color="fg.muted">Pull latest email and phone from your Clerk account</Text>
                  </VStack>
                )}
              </HStack>
            </Card.Header>
            <Card.Body py="3" px="4">
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
                <VStack align="start" gap={1}>
                  {targetUser?.email && (
                    <HStack fontSize="sm">
                      <Text color="fg.muted" w="80px">Email:</Text>
                      <Text>{targetUser.email}</Text>
                    </HStack>
                  )}
                  {(targetUser as any)?.phone && (
                    <HStack fontSize="sm">
                      <Text color="fg.muted" w="80px">Phone:</Text>
                      <Text>{(targetUser as any).phone}</Text>
                    </HStack>
                  )}
                  {!(targetUser as any)?.phone && (
                    <HStack fontSize="sm">
                      <Text color="fg.muted" w="80px">Phone:</Text>
                      <Text fontSize="xs" color="orange.500">Not set — add in Clerk to receive SMS</Text>
                    </HStack>
                  )}
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
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Home base card */}
          <Card.Root variant="outline">
            <Card.Header py="3" px="4" pb="0">
              <Text fontWeight="semibold">Home Base Address</Text>
            </Card.Header>
            <Card.Body py="3" px="4">
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
            <Card.Header py="3" px="4" pb="0">
              <Text fontWeight="semibold">Available Days</Text>
            </Card.Header>
            <Card.Body py="3" px="4">
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
            <Card.Header py="3" px="4" pb="0">
              <Text fontWeight="semibold">Hours Per Day</Text>
            </Card.Header>
            <Card.Body py="3" px="4">
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
              disabled={saving || !hasChanges}
            >
              {saving ? "Saving..." : "Save Profile"}
            </Button>
          </Box>
        </VStack>
      )}
    </Box>
  );
}
