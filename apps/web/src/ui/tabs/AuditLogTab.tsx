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
  HStack,
  useBreakpointValue,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { equipmentStatusColor } from "@/src/lib/lib";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { TabRolePropType } from "@/src/lib/types";

type AuditItem = {
  id: string;
  action: string;
  actorUserId?: string | null;
  metadata?: unknown;
  createdAt: string; // ISO
};

type AuditResp = { items: AuditItem[]; total: number };

// minimal shapes for lookups
type EqRow = {
  id: string;
  qrSlug: string;
  shortDesc: string;
  longDesc?: string | null;
  brand?: string | null;
  model?: string | null;
};
type UserRow = { id: string; email: string | null; displayName: string | null };

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

export default function AuditLogTab({ role = "worker" }: TabRolePropType) {
  if (role !== "admin") return <UnavailableNotice />;

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
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load audit log", err),
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

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return items;
    return items.filter((row) => {
      const action = row.action.toLowerCase();
      const actorEmail = (row.actorUserId && userMap[row.actorUserId]) || "";
      const actorL = actorEmail.toLowerCase();
      return (
        action.includes(ql) ||
        actorL.includes(ql) ||
        summaryCellText(row).toLowerCase().includes(ql)
      );
    });
  }, [items, q, userMap]);

  const truncW = useBreakpointValue({ base: "160px", md: "260px" }) ?? "260px";
  const colSpan = 4;

  // Text for the Details column (equipment OR role)
  function summaryCellText(row: AuditItem): string {
    const md = (row.metadata ?? {}) as any;

    if (
      row.action === "EQUIPMENT_CREATED" ||
      row.action === "EQUIPMENT_RESERVED" ||
      row.action === "EQUIPMENT_RESERVATION_CANCELLED" ||
      row.action === "EQUIPMENT_CHECKED_OUT" ||
      row.action === "EQUIPMENT_RETURNED" ||
      row.action === "EQUIPMENT_FORCE_RELEASED" ||
      row.action === "EQUIPMENT_MAINTENANCE_START" ||
      row.action === "EQUIPMENT_MAINTENANCE_END" ||
      row.action === "EQUIPMENT_RETIRED" ||
      row.action === "EQUIPMENT_UNRETIRED" ||
      row.action === "EQUIPMENT_UPDATED" ||
      row.action === "EQUIPMENT_DELETED"
    ) {
      const short = md.equipmentRecord.shortDesc;
      const qrSlug = md.equipmentRecord.qrSlug;
      return `${short} (${qrSlug})`;
    }

    if (
      row.action === "USER_APPROVED" ||
      row.action === "USER_ROLE_ASSIGNED" ||
      row.action === "USER_ROLE_REMOVED" ||
      row.action === "USER_DELETED"
    ) {
      const email = md.userRecord.email;
      const role = md.roleRecord?.role;
      return `${role ? role + " - " : ""}${email}`;
    }

    if (row.action === "CLIENT_CREATED" || row.action === "CLIENT_UPDATED") {
      let summary = "";
      if (md.clientRecord) {
        summary = md.clientRecord.displayName;
      }
      if (!summary && md.contactRecord) {
        summary = `${md.contactRecord.firstName} ${md.contactRecord.lastName}`;
      }
      return summary;
    }

    return "";
  }

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
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="audit-search"
          placeholder="Search…"
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
              <Table.ColumnHeader>Summary</Table.ColumnHeader>
              <Table.ColumnHeader>Initiator</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>

          <Table.Body>
            {filtered.map((row) => {
              const actorEmail =
                (row.actorUserId && userMap[row.actorUserId]) || "—";
              const details = summaryCellText(row);

              return (
                <Fragment key={row.id}>
                  <Table.Row
                    onClick={() => toggleDetails(row.id)}
                    _hover={{ bg: "gray.50", cursor: "pointer" }}
                    title="Click to toggle details"
                  >
                    <Table.Cell
                      title={new Date(row.createdAt).toLocaleString()}
                      whiteSpace="nowrap"
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
      actorUserId: row.actorUserId ?? null,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
    };
    return JSON.stringify(pretty, null, 2);
  } catch {
    return String(row.metadata ?? "");
  }
}
