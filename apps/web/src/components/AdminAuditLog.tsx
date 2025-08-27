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

const ACTIONS = [
  "USER_APPROVED",
  "ROLE_ASSIGNED",
  "EQUIPMENT_CREATED",
  "EQUIPMENT_UPDATED",
  "EQUIPMENT_RETIRED",
  "EQUIPMENT_DELETED",
  "EQUIPMENT_CHECKED_OUT",
  "EQUIPMENT_RELEASED",
  "MAINTENANCE_START",
  "MAINTENANCE_END",
] as const;

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

  const hasMore = useMemo(() => items.length < total, [items.length, total]);

  function toIsoStart(d: string) {
    return d ? new Date(`${d}T00:00:00`).toISOString() : undefined;
  }
  function toIsoEnd(d: string) {
    return d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined;
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
        `/api/v1/admin/audit?${params.toString()}`
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
    void load(true);
  }, []); // initial

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
          {items.map((row) => (
            <Table.Row key={row.id}>
              <Table.Cell>
                {new Date(row.createdAt).toLocaleString()}
              </Table.Cell>
              <Table.Cell>
                <Badge>{row.action}</Badge>
              </Table.Cell>
              <Table.Cell>
                <Text fontFamily="mono">{row.equipmentId ?? "—"}</Text>
              </Table.Cell>
              <Table.Cell>
                <Text fontFamily="mono">{row.actorUserId ?? "—"}</Text>
              </Table.Cell>
              <Table.Cell>
                <Text fontSize="sm" lineClamp={2}>
                  {formatMetadata(row.metadata)}
                </Text>
              </Table.Cell>
            </Table.Row>
          ))}
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

function formatMetadata(data: unknown): string {
  try {
    if (data == null) return "";
    return JSON.stringify(data, null, 0);
  } catch {
    return String(data);
  }
}
