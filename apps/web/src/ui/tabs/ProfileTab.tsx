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
import { apiGet, apiPatch } from "@/src/lib/api";
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
  const [homeBase, setHomeBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

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
      setHomeBase(me.homeBaseAddress ?? "");
      return;
    }
    // Admin viewing another user — fetch their data
    setLoading(true);
    apiGet<any>(`/api/admin/users/${targetUserId}`)
      .then((u) => {
        setHomeBase(u?.homeBaseAddress ?? "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [targetUserId, isSelf, me]);

  async function saveHomeBase() {
    setSaving(true);
    try {
      const endpoint = isAdmin && !isSelf
        ? `/api/admin/users/${targetUserId}/home-base`
        : "/api/home-base";
      await apiPatch(endpoint, { address: homeBase });
      publishInlineMessage({ type: "SUCCESS", text: "Home base address saved." });
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
        <VStack align="stretch" gap={4} maxW="lg">
          {/* Basic info card */}
          <Card.Root variant="outline">
            <Card.Header py="3" px="4" pb="0">
              <Text fontWeight="semibold">
                {targetUser?.displayName || targetUser?.email || "Profile"}
              </Text>
            </Card.Header>
            <Card.Body py="3" px="4">
              <VStack align="start" gap={2}>
                {targetUser?.email && (
                  <HStack fontSize="sm">
                    <Text color="fg.muted" w="80px">Email:</Text>
                    <Text>{targetUser.email}</Text>
                  </HStack>
                )}
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
                <Input
                  size="sm"
                  placeholder="e.g. 123 Main St, Chapel Hill, NC"
                  value={homeBase}
                  onChange={(e) => setHomeBase(e.target.value)}
                />
                <HStack>
                  <Button
                    size="sm"
                    colorPalette="green"
                    onClick={saveHomeBase}
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        </VStack>
      )}
    </Box>
  );
}
