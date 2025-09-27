// apps/web/src/components/AdminActivity.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Heading,
  Input,
  HStack,
  Button,
  Stack,
  Badge,
  Text,
  Spinner,
  Accordion,
} from "@chakra-ui/react";
import { apiGet } from "../lib/api";

type ActivityEvent = {
  id: string;
  at: string; // ISO
  type: string;
  summary?: string;
  details?: Record<string, any>;
};

type ActivityUser = {
  userId: string;
  displayName: string | null;
  email: string | null;
  lastActivityAt: string | null; // ISO
  count: number;
  events: ActivityEvent[]; // newest-first from the API
};

function prettyDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso || "—";
  }
}

// Match Audit Log colors
function actionBadgePalette(actRaw: string): string {
  const act = (actRaw || "").toUpperCase();
  if (act.includes("RETIRED") || act.includes("DELETED")) return "gray";
  if (act.includes("CHECKED_OUT") || act.includes("MAINTENANCE_START"))
    return "red";
  if (act.includes("MAINTENANCE_END")) return "yellow";
  if (act.includes("UPDATED") || act.includes("RESERVED")) return "orange";
  if (act.includes("APPROVED") || act.includes("ROLE_ASSIGNED"))
    return "purple";
  if (act.includes("RELEASED") || act.includes("FORCE_RELEASED")) return "blue";
  return "teal";
}

// Render a compact key → value list like the Equipment tab style.
// Shows recognized fields first; falls back to pretty JSON for unknown shapes.
function DetailsBlock({ details }: { details?: Record<string, any> | null }) {
  if (
    !details ||
    (typeof details === "object" && Object.keys(details).length === 0)
  ) {
    return null;
  }

  const name = details.equipmentName as string | undefined;
  const desc = details.equipmentDesc as string | undefined;

  // Known keys to show as key/value rows AFTER the name/desc block
  const knownOrder: Array<[string, string]> = [
    ["role", "Role"],
    ["qrSlug", "QR"],
    ["fromStatus", "From"],
    ["toStatus", "To"],
    ["notes", "Notes"],
    ["reason", "Reason"],
  ];

  const extras: Array<[string, any]> = [];
  const d = details as Record<string, any>;

  for (const [k, label] of knownOrder) {
    if (d[k] != null && d[k] !== "") extras.push([label, d[k]]);
  }

  // Gather any other primitive keys not yet shown (excluding equipmentName/Desc)
  Object.keys(d).forEach((k) => {
    if (k === "equipmentName" || k === "equipmentDesc") return;
    if (knownOrder.find(([kk]) => kk === k)) return;
    const v = d[k];
    if (v == null) return;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") {
      extras.push([k, v]);
    }
  });

  return (
    <Box mt="8px">
      {(name || desc) && (
        <Box mb={extras.length ? "6px" : "0"}>
          {name && (
            <Text fontWeight="semibold" lineHeight="1.2">
              {name}
            </Text>
          )}
          {desc && (
            <Text fontSize="sm" color="gray.600" lineHeight="1.2" mt="2px">
              {desc}
            </Text>
          )}
        </Box>
      )}

      {extras.length > 0 && (
        <Stack gap="4px" fontSize="xs" color="gray.700">
          {extras.map(([label, value]) => (
            <HStack key={label} align="start" gap="6px">
              <Text as="span" color="gray.500" minW="92px">
                {label}:
              </Text>
              <Text as="span" flex="1" wordBreak="break-word">
                {String(value)}
              </Text>
            </HStack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

export default function AdminActivity() {
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ActivityUser[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]); // Chakra v3 namespaced Accordion

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const data = await apiGet<ActivityUser[]>(
        `/api/admin/activity${query ? `?q=${encodeURIComponent(query)}` : ""}`
      );
      setRows(data);
      setExpanded([]); // collapse on new search
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const h = setTimeout(() => void load(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q, load]);

  useEffect(() => {
    void load("");
  }, [load]);

  const hasRows = rows.length > 0;

  const totalEvents = useMemo(
    () => rows.reduce((acc, r) => acc + (r.events?.length || 0), 0),
    [rows]
  );

  // --- NEW: sort users by most recent activity (latest first). Nulls go last.
  const sortedRows = useMemo(() => {
    const toTs = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
    return [...rows].sort((a, b) => {
      const tb = toTs(b.lastActivityAt);
      const ta = toTs(a.lastActivityAt);
      if (tb !== ta) return tb - ta; // desc
      // stable-ish fallback by displayName/email
      const an = (a.displayName || a.email || "").toLowerCase();
      const bn = (b.displayName || b.email || "").toLowerCase();
      return an.localeCompare(bn);
    });
  }, [rows]);

  const expandAll = () => setExpanded(sortedRows.map((u) => u.userId));
  const collapseAll = () => setExpanded([]);

  return (
    <Box>
      <Heading size="md" mb="3">
        Activity
      </Heading>

      {/* Controls */}
      <HStack wrap="wrap" gap="6px" mb="3">
        <Input
          placeholder="Search users or activity…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          w={{ base: "100%", md: "320px" }}
        />
        <HStack ml="auto" gap="6px">
          <Button
            size="sm"
            variant="outline"
            onClick={expandAll}
            disabled={!hasRows}
          >
            Expand all
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={collapseAll}
            disabled={!hasRows}
          >
            Collapse all
          </Button>
        </HStack>
      </HStack>

      {/* Summary */}
      <HStack fontSize="sm" color="gray.600" mb="2">
        <Text>
          {rows.length} user{rows.length !== 1 ? "s" : ""}
        </Text>
        <Text>·</Text>
        <Text>
          {totalEvents} event{totalEvents !== 1 ? "s" : ""}
        </Text>
      </HStack>

      {/* Loading / Empty */}
      {loading && (
        <Box py="10" textAlign="center">
          <Spinner size="lg" />
        </Box>
      )}
      {!loading && rows.length === 0 && (
        <Text color="gray.600">No matching activity.</Text>
      )}

      {/* Results — Chakra v3 namespaced Accordion */}
      {!loading && sortedRows.length > 0 && (
        <Accordion.Root
          multiple
          value={expanded}
          onValueChange={(details: { value: string[] }) =>
            setExpanded(details?.value ?? [])
          }
        >
          {sortedRows.map((u) => {
            const title = u.displayName || u.email || u.userId.slice(0, 8);
            return (
              <Accordion.Item
                key={u.userId}
                value={u.userId}
                style={{
                  borderRadius: "12px",
                  overflow: "hidden",
                  border: "1px solid var(--chakra-colors-gray-200)",
                  marginBottom: "8px",
                  background: "var(--chakra-colors-white)",
                }}
              >
                <Accordion.ItemTrigger
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    display: "block",
                    background: "var(--chakra-colors-white)",
                  }}
                >
                  <HStack
                    justify="space-between"
                    w="100%"
                    align="center"
                    wrap="wrap"
                    gap="6px"
                  >
                    <HStack gap="8px" minW="0">
                      <Text
                        fontWeight="semibold"
                        overflow="hidden"
                        textOverflow="ellipsis"
                      >
                        {title}
                      </Text>
                      {u.email && u.email !== title && <Badge>{u.email}</Badge>}
                    </HStack>
                    <HStack gap="8px">
                      <Badge colorPalette="gray">
                        {u.count} event{u.count !== 1 ? "s" : ""}
                      </Badge>
                      <Badge>Last: {prettyDate(u.lastActivityAt)}</Badge>
                      <Accordion.ItemIndicator />
                    </HStack>
                  </HStack>
                </Accordion.ItemTrigger>

                <Accordion.ItemContent>
                  <Stack p="12px" gap="8px">
                    {u.events.length === 0 && (
                      <Text color="gray.600" fontSize="sm">
                        No activity found for this user (within current limits).
                      </Text>
                    )}
                    {u.events.map((e) => (
                      <Box
                        key={e.id}
                        p="12px"
                        borderWidth="1px"
                        borderRadius="8px"
                        bg="white"
                      >
                        <HStack
                          justify="space-between"
                          align="start"
                          wrap="wrap"
                          gap="6px"
                        >
                          {/* Left: ONLY the colored status bubble */}
                          <Badge
                            colorPalette={actionBadgePalette(e.type)}
                            title={e.summary || undefined}
                          >
                            {e.type}
                          </Badge>

                          {/* Right: timestamp */}
                          <Text fontSize="sm" color="gray.600">
                            {prettyDate(e.at)}
                          </Text>
                        </HStack>

                        {/* Details, if present */}
                        <DetailsBlock details={e.details} />
                      </Box>
                    ))}
                  </Stack>
                </Accordion.ItemContent>
              </Accordion.Item>
            );
          })}
        </Accordion.Root>
      )}
    </Box>
  );
}
