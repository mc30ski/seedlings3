// apps/web/src/components/AdminAuditLog.tsx
import { useEffect, useMemo, useState, Fragment } from "react";
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
  useBreakpointValue,
} from "@chakra-ui/react";
import { apiGet } from "../../lib/api";
import { toaster } from "../old/toaster";
import { getErrorMessage } from "../../lib/errors";
import { equipmentStatusColor } from "../../lib/lib";

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
type EqRow = {
  id: string;
  shortDesc: string;
  longDesc?: string | null;
  brand?: string | null;
  model?: string | null;
};
type UserRow = { id: string; email: string | null; displayName: string | null };

const LoadingCenter = () => (
  <Box minH="160px" display="flex" alignItems="center" justifyContent="center">
    <Spinner size="lg" />
  </Box>
);

/** One-line, ellipsized text with native hover tooltip */
function Trunc({
  text,
  maxW = "220px",
  as = "span",
}: {
  text: string;
  maxW?: string | number | undefined;
  as?: any;
}) {
  return (
    <Text
      as={as}
      maxW={maxW}
      truncate
      title={text}
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

  // simple, Activity-style text search (client-side)
  const [q, setQ] = useState("");

  // date filters (server-side)
  const [from, setFrom] = useState(""); // yyyy-mm-dd
  const [to, setTo] = useState("");

  // lookups
  const [eqMap, setEqMap] = useState<
    Record<
      string,
      {
        name: string;
        desc: string;
        brand?: string | null;
        model?: string | null;
      }
    >
  >({});
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
      const eqIndex: Record<
        string,
        {
          name: string;
          desc: string;
          brand?: string | null;
          model?: string | null;
        }
      > = {};
      for (const e of eq) {
        eqIndex[e.id] = {
          name: e.shortDesc || e.id,
          desc: e.longDesc ?? "",
          brand: e.brand ?? null,
          model: e.model ?? null,
        };
      }
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

  async function load(
    reset = false,
    pageOverride?: number,
    pageSizeOverride?: number
  ) {
    setLoading(true);
    try {
      const p = pageOverride ?? (reset ? 1 : page);
      const ps = pageSizeOverride ?? pageSize;

      const params = new URLSearchParams();
      params.set("page", String(p));
      params.set("pageSize", String(ps));
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
    setFrom("");
    setTo("");
    setQ("");
    setOpen({});
    void load(true);
  }

  const toggleDetails = (id: string) =>
    setOpen((m) => ({ ...m, [id]: !m[id] }));

  // client-side Activity-like search over loaded rows
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return items;
    return items.filter((row) => {
      const action = row.action.toLowerCase();
      const eq = row.equipmentId ? eqMap[row.equipmentId] : undefined;
      const eqName = (eq?.name ?? "").toLowerCase();
      const eqDesc = (eq?.desc ?? "").toLowerCase();
      const actorEmail = (row.actorUserId && userMap[row.actorUserId]) || "";
      const actorL = actorEmail.toLowerCase();
      let md = "";
      try {
        md = JSON.stringify(row.metadata ?? {}).toLowerCase();
      } catch {}
      const idBits =
        (row.id?.slice(0, 8) ?? "") +
        (row.equipmentId?.slice(0, 8) ?? "") +
        (row.actorUserId?.slice(0, 8) ?? "");
      return (
        action.includes(ql) ||
        eqName.includes(ql) ||
        eqDesc.includes(ql) ||
        actorL.includes(ql) ||
        md.includes(ql) ||
        idBits.includes(ql)
      );
    });
  }, [items, q, eqMap, userMap]);

  // widths / colspans
  const truncW = useBreakpointValue({ base: "160px", md: "260px" }) ?? "260px";
  // Now: 4 columns on mobile (Time, Action, Details, Actor) and also 4 on md+
  const colSpan = 4;

  // Text for the Details column (equipment OR role)
  function detailsCellText(row: AuditItem): string {
    const md = (row.metadata ?? {}) as any;

    // Role-centric events
    if (row.action === "ROLE_ASSIGNED" && md?.role) {
      return `Role: ${String(md.role)}`;
    }
    if (row.action === "USER_APPROVED") {
      return "User approved";
    }

    // Equipment-centric
    if (row.equipmentId) {
      const eq = eqMap[row.equipmentId];
      const name = (md?.equipment?.shortDesc ??
        md?.shortDesc ??
        eq?.name ??
        row.equipmentId) as string;
      const desc = (md?.equipment?.longDesc ??
        md?.longDesc ??
        eq?.desc ??
        "") as string;
      const brand = (md?.equipment?.brand ??
        md?.brand ??
        eq?.brand ??
        "") as string;
      const model = (md?.equipment?.model ??
        md?.model ??
        eq?.model ??
        "") as string;
      const label = [brand, model].filter(Boolean).join(" ");
      const head = label ? `${label} — ${name}` : name;
      return desc ? `${head} — ${desc}` : head;
    }

    // Other bits
    const extras = md?.reason || md?.notes || md?.via || "";
    return extras ? String(extras) : "—";
  }

  // handler to auto-apply page size change (footer selector)
  const onChangePageSize = (n: number) => {
    setPageSize(n);
    setPage(1);
    void load(true, 1, n);
  };

  return (
    <Box>
      <Heading size="md" mb={4}>
        Audit
      </Heading>

      {/* Filters */}
      <Stack
        direction={{ base: "column", md: "row" }}
        gap="3"
        mb={3}
        align="center"
      >
        <Input
          placeholder="Search (status, equipment, actor, details)"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          maxW={{ base: "100%", md: "360px" }}
          flex="0 0 auto"
        />
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
          title="From date"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
          title="To date"
        />
        <HStack gap="2" ml="auto">
          <Button onClick={applyFilters} disabled={loading} loading={loading}>
            Apply
          </Button>
          <Button variant="outline" onClick={clearFilters} disabled={loading}>
            Clear
          </Button>
        </HStack>
      </Stack>

      {/* Loading */}
      {loading && items.length === 0 && <LoadingCenter />}

      {/* Table */}
      <Box
        overflowX="auto"
        w="100%"
        maxW="100vw"
        mt={2}
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <Table.Root
          size="sm"
          variant="outline"
          minW={{ base: "720px", md: "unset" }}
        >
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Time</Table.ColumnHeader>
              <Table.ColumnHeader>Action</Table.ColumnHeader>
              <Table.ColumnHeader>Details</Table.ColumnHeader>
              {/* NEW trailing Actor column */}
              <Table.ColumnHeader>Actor</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>

          <Table.Body>
            {filtered.map((row) => {
              const actorEmail =
                (row.actorUserId && userMap[row.actorUserId]) || "—";
              const details = detailsCellText(row);

              return (
                <Fragment key={row.id}>
                  <Table.Row
                    onClick={() => toggleDetails(row.id)}
                    _hover={{ bg: "gray.50", cursor: "pointer" }}
                    title="Click to toggle details"
                  >
                    <Table.Cell
                      title={new Date(row.createdAt).toLocaleString()}
                    >
                      {new Date(row.createdAt).toLocaleString()}
                    </Table.Cell>

                    <Table.Cell>
                      <Badge colorPalette={equipmentStatusColor(row.action)}>
                        {row.action}
                      </Badge>
                    </Table.Cell>

                    {/* DETAILS column (equipment OR role summary) */}
                    <Table.Cell>
                      <Trunc text={details} maxW={truncW} />
                    </Table.Cell>

                    {/* NEW trailing Actor column (email only) */}
                    <Table.Cell>
                      <Trunc text={actorEmail} maxW={truncW} />
                    </Table.Cell>
                  </Table.Row>

                  {open[row.id] && (
                    <Table.Row key={`${row.id}-details`}>
                      <Table.Cell colSpan={colSpan}>
                        <Box
                          mt={2}
                          p={3}
                          borderWidth="1px"
                          borderRadius="md"
                          bg="gray.50"
                          overflowX="auto"
                          maxW="100%"
                          style={{ WebkitOverflowScrolling: "touch" }}
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
                </Fragment>
              );
            })}

            {filtered.length === 0 && !loading && (
              <Table.Row>
                <Table.Cell colSpan={colSpan}>
                  <Text>No results.</Text>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Root>
      </Box>

      {/* Footer: items-per-page (auto-applies on change) + load more */}
      <Stack
        direction={{ base: "column", md: "row" }}
        gap="3"
        mt={3}
        align="center"
      >
        <Text flex="1">
          Showing {items.length} of {total}
        </Text>

        <HStack gap="2">
          <Text fontSize="sm" color="gray.600">
            Items per page:
          </Text>
          <select
            value={pageSize}
            onChange={(e) => onChangePageSize(Number(e.currentTarget.value))}
            style={{
              padding: "8px",
              borderRadius: "8px",
              border: "1px solid var(--chakra-colors-border)",
            }}
            title="Rows per page"
          >
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}/page
              </option>
            ))}
          </select>
        </HStack>

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
      actorUserId: row.actorUserId ?? null, // kept in raw JSON
      equipmentId: row.equipmentId ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
    };
    return JSON.stringify(pretty, null, 2);
  } catch {
    return String(row.metadata ?? "");
  }
}
