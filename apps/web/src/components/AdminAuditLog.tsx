// apps/web/src/components/AdminAuditLog.tsx
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Heading,
  Stack,
  Input,
  Text,
  Badge,
  Table,
  Spinner,
  HStack,
} from "@chakra-ui/react";
import { apiGet } from "../lib/api";
import { toaster } from "./ui/toaster";
import { getErrorMessage } from "../lib/errors";

type AuditItem = {
  id: string;
  action: string;
  actorUserId?: string | null;
  equipmentId?: string | null;
  metadata?: unknown;
  createdAt: string; // ISO
};

type AuditResp = { items: AuditItem[]; total: number };

// minimal shapes for lookups
type EqRow = { id: string; shortDesc: string };
type UserRow = { id: string; email: string | null; displayName: string | null };

const ACTIONS = [
  "USER_APPROVED",
  "ROLE_ASSIGNED",
  "EQUIPMENT_CREATED",
  "EQUIPMENT_UPDATED",
  "EQUIPMENT_RETIRED",
  "EQUIPMENT_DELETED",
  "EQUIPMENT_CHECKED_OUT",
  "EQUIPMENT_RELEASED", // legacy-safe
  "MAINTENANCE_START",
  "MAINTENANCE_END",
] as const;

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

/** Small helper to render one-line, ellipsized text with native hover tooltip */
function Trunc({
  text,
  maxW = "220px",
  as = "span",
}: {
  text: string;
  maxW?: string | number;
  as?: any;
}) {
  return (
    <Text
      as={as}
      maxW={maxW}
      lineClamp={1} // Chakra v3 (replaces noOfLines)
      title={text} // native tooltip on hover
      display="inline-block"
      verticalAlign="middle"
    >
      {text}
    </Text>
  );
}

export default function AdminAuditLog() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);

  // filters
  const [actorUserId, setActor] = useState("");
  const [equipmentId, setEquip] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState(""); // yyyy-mm-dd
  const [to, setTo] = useState("");

  // lookups
  const [eqMap, setEqMap] = useState<Record<string, string>>({});
  const [userMap, setUserMap] = useState<Record<string, string>>({}); // id -> email

  // open details per row id
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const hasMore = useMemo(() => items.length < total, [items.length, total]);

  function toIsoStart(d: string) {
    return d ? new Date(`${d}T00:00:00`).toISOString() : undefined;
  }
  function toIsoEnd(d: string) {
    return d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined;
  }

  async function loadLookups() {
    try {
      const eq = await apiGet<EqRow[]>(`/api/admin/equipment`);
      const eqIndex: Record<string, string> = {};
      for (const e of eq) eqIndex[e.id] = e.shortDesc || e.id;
      setEqMap(eqIndex);
    } catch {
      setEqMap({});
    }

    try {
      const users = await apiGet<UserRow[]>(`/api/admin/users`);
      const uIndex: Record<string, string> = {};
      for (const u of users) uIndex[u.id] = u.email ?? "";
      setUserMap(uIndex);
    } catch {
      setUserMap({});
    }
  }

  async function load(reset = false, pageOverride?: number) {
    setLoading(true);
    try {
      const p = pageOverride ?? (reset ? 1 : page);
      const params = new URLSearchParams();
      params.set("page", String(p));
      params.set("pageSize", String(pageSize));
      if (actorUserId.trim()) params.set("actorUserId", actorUserId.trim());
      if (equipmentId.trim()) params.set("equipmentId", equipmentId.trim());
      if (action) params.set("action", action);
      const fromIso = toIsoStart(from);
      if (fromIso) params.set("from", fromIso);
      const toIso = toIsoEnd(to);
      if (toIso) params.set("to", toIso);

      const res = await apiGet<AuditResp>(
        `/api/admin/audit?${params.toString()}`
      );
      setTotal(res.total);
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      if (reset) setPage(1);
      if (pageOverride) setPage(pageOverride);
    } catch (err) {
      toaster.error({
        title: "Failed to load audit log",
        description: getErrorMessage(err),
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLookups();
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters() {
    void load(true);
  }

  async function loadMore() {
    const next = page + 1;
    await load(false, next);
  }

  function clearFilters() {
    setActor("");
    setEquip("");
    setAction("");
    setFrom("");
    setTo("");
    void load(true);
  }

  const toggleDetails = (id: string) =>
    setOpen((m) => ({ ...m, [id]: !m[id] }));

  const actionBadgePalette = (act: string) => {
    if (act.includes("RETIRED") || act.includes("DELETED")) return "gray";
    if (act.includes("CHECKED_OUT") || act.includes("MAINTENANCE_START"))
      return "red";
    if (act.includes("MAINTENANCE_END")) return "yellow";
    if (act.includes("UPDATED") || act.includes("RESERVED")) return "orange";
    if (act.includes("APPROVED") || act.includes("ROLE_ASSIGNED"))
      return "purple";
    if (act.includes("RELEASED") || act.includes("FORCE_RELEASED"))
      return "blue";
    return "teal";
  };

  return (
    <Box>
      <Heading size="md" mb={4}>
        Audit Log
      </Heading>

      {/* Filters */}
      <Stack direction={{ base: "column", md: "row" }} gap="3" mb={3}>
        <Input
          placeholder="Actor User ID"
          value={actorUserId}
          onChange={(e) => setActor(e.currentTarget.value)}
        />
        <Input
          placeholder="Equipment ID"
          value={equipmentId}
          onChange={(e) => setEquip(e.currentTarget.value)}
        />

        {/* Native select for Action */}
        <select
          value={action}
          onChange={(e) => setAction(e.currentTarget.value)}
          style={{
            padding: "8px",
            borderRadius: "8px",
            border: "1px solid var(--chakra-colors-border)",
          }}
        >
          <option value="">Action (Any)</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
        />

        {/* Native select for Page size */}
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.currentTarget.value))}
          style={{
            padding: "8px",
            borderRadius: "8px",
            border: "1px solid var(--chakra-colors-border)",
          }}
        >
          {[25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n}/page
            </option>
          ))}
        </select>

        <Button onClick={applyFilters} disabled={loading} loading={loading}>
          Apply
        </Button>
        <Button variant="outline" onClick={clearFilters} disabled={loading}>
          Clear
        </Button>
      </Stack>

      {/* Loading */}
      {loading && items.length === 0 && <LoadingCenter />}

      {/* Table */}
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Time</Table.ColumnHeader>
            <Table.ColumnHeader>Action</Table.ColumnHeader>
            <Table.ColumnHeader>Equipment</Table.ColumnHeader>
            <Table.ColumnHeader>Actor</Table.ColumnHeader>
            <Table.ColumnHeader>Details</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {items.map((row) => {
            const eqName = (row.equipmentId && eqMap[row.equipmentId]) || "—";
            const actorEmail =
              (row.actorUserId && userMap[row.actorUserId]) || "—";

            return (
              <>
                <Table.Row key={row.id}>
                  <Table.Cell title={new Date(row.createdAt).toLocaleString()}>
                    {new Date(row.createdAt).toLocaleString()}
                  </Table.Cell>

                  <Table.Cell>
                    <Badge colorPalette={actionBadgePalette(row.action)}>
                      {row.action}
                    </Badge>
                  </Table.Cell>

                  <Table.Cell>
                    <HStack gap="2" wrap="wrap" maxW="360px">
                      {row.equipmentId ? (
                        <>
                          {/* Ellipsize long names, show full name on hover */}
                          <Trunc text={eqName} />
                          {/* Short id badge with full id on hover */}
                          <Badge
                            variant="subtle"
                            colorPalette="gray"
                            title={row.equipmentId}
                          >
                            {row.equipmentId.slice(0, 8)}…
                          </Badge>
                        </>
                      ) : (
                        <Text>—</Text>
                      )}
                    </HStack>
                  </Table.Cell>

                  <Table.Cell>
                    <HStack gap="2" wrap="wrap" maxW="360px">
                      {/* Ellipsize email; full on hover */}
                      <Trunc text={actorEmail} />
                      {row.actorUserId && (
                        <Badge
                          variant="subtle"
                          colorPalette="gray"
                          title={row.actorUserId}
                        >
                          {row.actorUserId.slice(0, 8)}…
                        </Badge>
                      )}
                    </HStack>
                  </Table.Cell>

                  <Table.Cell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleDetails(row.id)}
                    >
                      {open[row.id] ? "Hide details" : "Open details"}
                    </Button>
                  </Table.Cell>
                </Table.Row>

                {open[row.id] && (
                  <Table.Row key={`${row.id}-details`}>
                    <Table.Cell colSpan={5}>
                      <Box
                        mt={2}
                        p={3}
                        borderWidth="1px"
                        borderRadius="md"
                        bg="gray.50"
                      >
                        <Text fontSize="sm" mb={1} color="gray.700">
                          Raw event data
                        </Text>
                        <Box
                          as="pre"
                          fontSize="xs"
                          whiteSpace="pre-wrap"
                          wordBreak="break-word"
                          m={0}
                        >
                          {formatMetadata(row)}
                        </Box>
                      </Box>
                    </Table.Cell>
                  </Table.Row>
                )}
              </>
            );
          })}

          {items.length === 0 && !loading && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <Text>No results.</Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>

      <Stack direction="row" gap="3" mt={3} align="center">
        <Text flex="1">
          Showing {items.length} of {total}
        </Text>
        <Button
          onClick={loadMore}
          disabled={!hasMore || loading}
          loading={loading}
        >
          {hasMore ? "Load more" : "No more"}
        </Button>
      </Stack>
    </Box>
  );
}

function formatMetadata(row: AuditItem): string {
  try {
    const pretty = {
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId ?? null,
      equipmentId: row.equipmentId ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
    };
    return JSON.stringify(pretty, null, 2);
  } catch {
    return String(row.metadata ?? "");
  }
}
