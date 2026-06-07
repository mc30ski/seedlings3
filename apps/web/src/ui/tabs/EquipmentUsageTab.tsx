"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  SimpleGrid,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { bizDateKey, bizToday, bizAddDays, fmtDateOpts } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Purpose = "WORKER" | "ADMIN";

type EquipmentBrief = {
  id: string;
  shortDesc?: string | null;
  brand?: string | null;
  model?: string | null;
  type?: string | null;
  qrSlug?: string | null;
};

type UsageRow = {
  id: string;
  equipmentId: string;
  equipment: EquipmentBrief;
  user: { id: string; displayName?: string | null; email?: string | null } | null;
  group: { id: string; name: string } | null;
  checkedOutAt: string | null;
  releasedAt: string | null;
  rentalDays: number | null;
  active: boolean;
};

type Collection = {
  id: string;
  name: string;
  items: { equipmentId: string }[];
};

// Rolling backward windows — a usage log reads naturally as "the last N days",
// not month/quarter-to-date (those are tax-shaped, wrong for an activity feed).
type UsagePreset = "all" | "7" | "30" | "90" | "365";
const USAGE_PRESETS: { key: UsagePreset; label: string }[] = [
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "365", label: "Last year" },
  { key: "all", label: "All time" },
];

function rangeForPreset(p: UsagePreset): { from: string; to: string } {
  if (p === "all") return { from: "", to: "" };
  const days = Number(p);
  const to = bizToday();
  return { from: bizAddDays(to, -days), to };
}

function equipmentLabel(e: EquipmentBrief): string {
  if (e.shortDesc) return e.shortDesc;
  const parts = [e.brand, e.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (e.type) return e.type;
  return e.id.slice(-6);
}

function personLabel(u: UsageRow["user"]): string {
  if (!u) return "Unknown";
  return u.displayName || u.email || u.id.slice(-6);
}

// Whole days a checkout was/has been out — same-day counts as 1.
function daysOut(c: UsageRow): number {
  if (!c.checkedOutAt) return 0;
  const start = new Date(c.checkedOutAt).getTime();
  const end = c.releasedAt ? new Date(c.releasedAt).getTime() : Date.now();
  return Math.max(1, Math.ceil((end - start) / 86400000));
}

function fmtDate(s: string | null): string {
  return fmtDateOpts(s, { month: "short", day: "numeric" });
}

type GroupByMode = "person" | "equipment" | "collection" | "day";

export default function EquipmentUsageTab({ purpose }: { purpose: Purpose }) {
  const isAdmin = purpose === "ADMIN";
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = usePersistedState<UsagePreset>(
    `usagePreset_${purpose}`,
    "30",
  );
  const [groupBy, setGroupBy] = usePersistedState<GroupByMode>(
    `usageGroupBy_${purpose}`,
    isAdmin ? "person" : "equipment",
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const { from, to } = rangeForPreset(preset);
        const qs = new URLSearchParams();
        if (from) qs.set("from", from);
        if (to) qs.set("to", to);
        const base = isAdmin ? "/api/admin/equipment-usage" : "/api/equipment-usage";
        const [usage, cols] = await Promise.all([
          apiGet<UsageRow[]>(`${base}?${qs}`),
          apiGet<Collection[]>("/api/equipment-collections"),
        ]);
        setRows(Array.isArray(usage) ? usage : []);
        setCollections(Array.isArray(cols) ? cols : []);
      } catch (err) {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Load failed.", err) });
      }
      setLoading(false);
    })();
  }, [preset, isAdmin]);

  // equipmentId → collection names it belongs to
  const equipmentCollections = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of collections) {
      for (const it of c.items) {
        const arr = map.get(it.equipmentId) ?? [];
        arr.push(c.name);
        map.set(it.equipmentId, arr);
      }
    }
    return map;
  }, [collections]);

  const summary = useMemo(() => {
    const distinctEquipment = new Set(rows.map((r) => r.equipmentId));
    const activeCount = rows.filter((r) => r.active).length;
    const totalDays = rows.reduce((sum, r) => sum + daysOut(r), 0);
    return {
      checkouts: rows.length,
      equipment: distinctEquipment.size,
      active: activeCount,
      totalDays,
    };
  }, [rows]);

  type Group = { key: string; label: string; rows: UsageRow[]; days: number };

  const groups = useMemo<Group[]>(() => {
    const buckets = new Map<string, { label: string; rows: UsageRow[] }>();
    const add = (key: string, label: string, row: UsageRow) => {
      const b = buckets.get(key) ?? { label, rows: [] };
      b.rows.push(row);
      buckets.set(key, b);
    };
    for (const r of rows) {
      if (groupBy === "person") {
        add(r.user?.id ?? "unknown", personLabel(r.user), r);
      } else if (groupBy === "equipment") {
        add(r.equipmentId, equipmentLabel(r.equipment), r);
      } else if (groupBy === "day") {
        const key = r.checkedOutAt ? bizDateKey(r.checkedOutAt) : "unknown";
        const label = r.checkedOutAt
          ? fmtDateOpts(r.checkedOutAt, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })
          : "Unknown date";
        add(key, label, r);
      } else {
        // collection — a checkout lands in every collection its equipment is in
        const names = equipmentCollections.get(r.equipmentId) ?? [];
        if (names.length === 0) {
          add("__none__", "Not in a collection", r);
        } else {
          for (const n of names) add(`col:${n}`, n, r);
        }
      }
    }
    const list: Group[] = Array.from(buckets.entries()).map(([key, b]) => ({
      key,
      label: b.label,
      rows: b.rows,
      days: b.rows.reduce((s, r) => s + daysOut(r), 0),
    }));
    // Day groups read newest-first; everything else by activity volume.
    if (groupBy === "day") list.sort((a, b) => (a.key < b.key ? 1 : -1));
    else list.sort((a, b) => b.rows.length - a.rows.length);
    return list;
  }, [rows, groupBy, equipmentCollections]);

  const groupModes: { key: GroupByMode; label: string }[] = isAdmin
    ? [
        { key: "person", label: "Person" },
        { key: "equipment", label: "Equipment" },
        { key: "collection", label: "Collection" },
        { key: "day", label: "Day" },
      ]
    : [
        { key: "equipment", label: "Equipment" },
        { key: "collection", label: "Collection" },
        { key: "day", label: "Day" },
      ];

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Box w="full">
      <VStack align="stretch" gap={3}>
        <Box>
          <Text fontWeight="semibold">
            Equipment usage{!isAdmin && " — yours"}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {isAdmin
              ? "Every worker's checkouts over the selected window."
              : "Equipment you've checked out over the selected window."}
          </Text>
        </Box>

        {/* Timeframe */}
        <HStack gap={2} flexWrap="wrap">
          {USAGE_PRESETS.map((p) => (
            <Button
              key={p.key}
              size="xs"
              variant={preset === p.key ? "solid" : "outline"}
              colorPalette={preset === p.key ? "blue" : "gray"}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </Button>
          ))}
        </HStack>

        {loading ? (
          <Spinner size="sm" />
        ) : (
          <>
            {/* Summary */}
            <SimpleGrid columns={{ base: 2, md: 4 }} gap={2}>
              <SummaryCard label="Checkouts" value={summary.checkouts} />
              <SummaryCard label="Equipment used" value={summary.equipment} />
              <SummaryCard
                label="Out now"
                value={summary.active}
                colorPalette={summary.active > 0 ? "blue" : undefined}
              />
              <SummaryCard label="Total days" value={summary.totalDays} />
            </SimpleGrid>

            {/* Group-by */}
            <HStack gap={2} flexWrap="wrap">
              <Text fontSize="xs" color="fg.muted">
                Group by
              </Text>
              {groupModes.map((m) => (
                <Button
                  key={m.key}
                  size="xs"
                  variant={groupBy === m.key ? "solid" : "outline"}
                  colorPalette={groupBy === m.key ? "teal" : "gray"}
                  onClick={() => {
                    setGroupBy(m.key);
                    setExpanded(new Set());
                  }}
                >
                  {m.label}
                </Button>
              ))}
            </HStack>

            {/* Groups */}
            {groups.length === 0 ? (
              <Card.Root variant="outline">
                <Card.Body py={6} textAlign="center">
                  <Text color="fg.muted" fontSize="sm">
                    No equipment usage in this window.
                  </Text>
                </Card.Body>
              </Card.Root>
            ) : (
              groups.map((g) => {
                const open = expanded.has(g.key);
                return (
                  <Card.Root key={g.key} variant="outline">
                    <Card.Body py="2" px="3">
                      <HStack
                        justify="space-between"
                        cursor="pointer"
                        onClick={() => toggle(g.key)}
                      >
                        <HStack gap={2} minW={0}>
                          {open ? (
                            <ChevronDown size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                          <Text fontWeight="semibold" lineHeight="1.2">
                            {g.label}
                          </Text>
                        </HStack>
                        <HStack gap={1.5} flexShrink={0}>
                          <Badge size="sm" colorPalette="gray">
                            {g.rows.length} checkout
                            {g.rows.length === 1 ? "" : "s"}
                          </Badge>
                          <Badge size="sm" colorPalette="purple">
                            {g.days} day{g.days === 1 ? "" : "s"}
                          </Badge>
                        </HStack>
                      </HStack>

                      {open && (
                        <VStack align="stretch" gap={1} mt={2}>
                          {g.rows.map((r) => {
                            // Context line — the dimensions NOT already named
                            // by this group's header, so nothing is repeated.
                            const ctx: string[] = [];
                            if (groupBy !== "equipment")
                              ctx.push(equipmentLabel(r.equipment));
                            if (isAdmin && groupBy !== "person")
                              ctx.push(personLabel(r.user));
                            if (r.group) ctx.push(r.group.name);
                            return (
                              <HStack
                                key={r.id}
                                justify="space-between"
                                gap={2}
                                px={2}
                                py={1.5}
                                borderRadius="md"
                                bg="bg.subtle"
                              >
                                <VStack align="start" gap={0} minW={0}>
                                  <Text fontSize="sm" lineHeight="1.3">
                                    {fmtDate(r.checkedOutAt)} →{" "}
                                    {r.active ? "out" : fmtDate(r.releasedAt)}
                                  </Text>
                                  {ctx.length > 0 && (
                                    <Text fontSize="xs" color="fg.muted">
                                      {ctx.join(" · ")}
                                    </Text>
                                  )}
                                </VStack>
                                <HStack gap={1.5} flexShrink={0}>
                                  {r.active && (
                                    <Badge size="sm" colorPalette="blue">
                                      Out
                                    </Badge>
                                  )}
                                  <Badge size="sm" colorPalette="purple">
                                    {daysOut(r)}d
                                  </Badge>
                                </HStack>
                              </HStack>
                            );
                          })}
                        </VStack>
                      )}
                    </Card.Body>
                  </Card.Root>
                );
              })
            )}
          </>
        )}
      </VStack>
    </Box>
  );
}

function SummaryCard(props: {
  label: string;
  value: number;
  colorPalette?: string;
}) {
  return (
    <Card.Root variant="outline">
      <Card.Body py="2" px="3">
        <Text
          fontSize="xl"
          fontWeight="bold"
          color={props.colorPalette ? `${props.colorPalette}.600` : undefined}
        >
          {props.value}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          {props.label}
        </Text>
      </Card.Body>
    </Card.Root>
  );
}
