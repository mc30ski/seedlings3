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
import { apiGet } from "../../lib/api";
import { actionStatusColor } from "../../lib/lib";

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

function DetailsBlock({ details }: { details?: Record<string, any> | null }) {
  if (
    !details ||
    (typeof details === "object" && Object.keys(details).length === 0)
  ) {
    return null;
  }

  return (
    <Box mt="8px">
      {details.role && <Heading size="sm">{details.role}</Heading>}

      {(details.equipmentName || details.qrSlug) && (
        <Box>
          {details.equipmentName && (
            <Heading size="md">{details.equipmentName}</Heading>
          )}
          <Heading size="sm">
            {details.brand ? `${details.brand} ` : ""}
            {details.model ? `${details.model} ` : ""}
          </Heading>
          {details.qrSlug && (
            <Text fontSize="sm" color="gray.500" mt={1}>
              <Text as="span" fontWeight="bold">
                ID:{" "}
              </Text>
              {details.qrSlug}
            </Text>
          )}
        </Box>
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
            const displayName = u.displayName || u.email;
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
                        fontSize="sm"
                        fontWeight="semibold"
                        overflow="hidden"
                        textOverflow="ellipsis"
                      >
                        {displayName || "(no name)"}
                      </Text>
                      {displayName !== u.email && <Badge>{u.email}</Badge>}
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
                          <Badge
                            fontSize="xs"
                            colorPalette={actionStatusColor(e.type)}
                            title={e.summary || undefined}
                          >
                            {e.type}
                          </Badge>

                          <Text fontSize="xs" color="gray.600">
                            {prettyDate(e.at)}
                          </Text>
                        </HStack>

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
