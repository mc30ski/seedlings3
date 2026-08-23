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
  Select,
  createListCollection,
  useBreakpointValue,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { fmtDateTime } from "@/src/lib/dates";
import { equipmentStatusColor } from "@/src/lib/statusColors";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
//TODO:
export type TabRolePropType = { role: "worker" | "admin" };

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

export default function HistoryTab({ role = "worker" }: TabRolePropType) {
  if (role !== "admin") return <UnavailableNotice />;

  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const pageSizeCollection = useMemo(
    () => createListCollection({
      items: [
        { label: "25/page", value: "25" },
        { label: "50/page", value: "50" },
        { label: "100/page", value: "100" },
      ],
    }),
    [],
  );

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

  function toDateParam(d: string) {
    return d || undefined;
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
      const fromParam = toDateParam(from);
      if (fromParam) params.set("from", fromParam);
      const toParam = toDateParam(to);
      if (toParam) params.set("to", toParam);

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
        text: getErrorMessage("Failed to load history", err),
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

  // Text for the Details column
  function summaryCellText(row: AuditItem): string {
    const md = (row.metadata ?? {}) as any;
    const action = row.action;

    // Equipment
    if (action?.startsWith("EQUIPMENT_")) {
      const eq = md.equipmentRecord;
      if (!eq) return "";
      const base = `${eq.shortDesc ?? ""} (${eq.qrSlug ?? ""})`;
      // Super on-behalf-of marker — set by equipment.ts when actor != target.
      // Renders inline so an operator scanning the feed sees the override.
      const onBehalfOf = md.actedOnBehalfOfUserId
        ? (userMap[md.actedOnBehalfOfUserId] || md.actedOnBehalfOfUserId)
        : null;
      return onBehalfOf ? `${base} — on behalf of ${onBehalfOf}` : base;
    }

    // User
    if (action?.startsWith("USER_")) {
      // Guaranteed-payout period events — render the target contractor
      // and the period boundary so the summary actually says something.
      // The route writes targetUserId/targetName/until in metadata;
      // targetName is the at-write-time display name (handles deleted
      // users gracefully). The cron-written natural-expiration row carries
      // endedEarly: false; ones written by the route on operator early-end
      // carry endedEarly: true.
      if (action === "USER_GUARANTEED_PAYOUT_STARTED") {
        const who = md.targetName || (md.targetUserId && userMap[md.targetUserId]) || md.targetUserId || "";
        const until = md.until ? fmtDateTime(md.until).split(",")[0] : "—";
        const extension = md.extension ? " (extended)" : "";
        return who
          ? `Guaranteed payout through ${until}${extension} — ${who}`
          : `Guaranteed payout through ${until}${extension}`;
      }
      if (action === "USER_GUARANTEED_PAYOUT_ENDED") {
        const who = md.targetName || (md.targetUserId && userMap[md.targetUserId]) || md.targetUserId || "";
        const previousUntil = md.previousUntil ? fmtDateTime(md.previousUntil).split(",")[0] : "";
        const earlySuffix = md.endedEarly ? " ended early" : " auto-expired";
        return who
          ? `Guaranteed payout${earlySuffix}${previousUntil ? ` (was: ${previousUntil})` : ""} — ${who}`
          : `Guaranteed payout${earlySuffix}${previousUntil ? ` (was: ${previousUntil})` : ""}`;
      }
      const email = md.userRecord?.email ?? "";
      const role = md.roleRecord?.role;
      return role ? `${role} — ${email}` : email;
    }

    // Property
    if (action?.startsWith("PROPERTY_")) {
      const name = md.displayName ?? "";
      if (name) return name;
      return md.propertyId ? `Property ${md.propertyId.slice(0, 8)}…` : "";
    }

    // Client
    if (action?.startsWith("CLIENT_")) {
      // contact actions have contactRecord
      if (md.contactRecord) {
        const name = [md.contactRecord.firstName, md.contactRecord.lastName]
          .filter(Boolean)
          .join(" ");
        const email = md.contactRecord.email;
        return name || email || "";
      }
      // client record
      if (md.record?.displayName) return md.record.displayName;
      return "";
    }

    // Job
    if (action?.startsWith("JOB_")) {
      // Assignee actions have an action field
      if (md.action) {
        const verb: Record<string, string> = {
          claimed: "Claimed",
          unclaimed: "Unclaimed",
          added: "Assignee added",
          removed: "Assignee removed",
        };
        const label = verb[md.action] ?? md.action;
        return md.occurrenceId
          ? `${label} — occ ${md.occurrenceId.slice(0, 8)}…`
          : label;
      }
      // Occurrence updated: show status change
      if (md.occurrenceId && md.record?.status) {
        return `Occurrence → ${md.record.status}`;
      }
      if (md.occurrenceId) {
        return `Occurrence ${md.occurrenceId.slice(0, 8)}…`;
      }
      // Job created/updated: show kind + status
      if (md.record) {
        const parts = [md.record.kind, md.record.status].filter(Boolean);
        return parts.join(" / ");
      }
      if (md.jobId) return `Job ${md.jobId.slice(0, 8)}…`;
      return "";
    }

    // Promotions — lifecycle + edit + burst events. Metadata always
    // carries `promotionId`; state transitions also carry `fromStatus`
    // + `toStatus`; dispatches carry `dispatchId` + `sent` + `skipped`;
    // test sends carry `channel`. The action string is
    // `PROMOTION_<VERB>` (some verbs are themselves prefixed with
    // `PROMOTION_`, producing `PROMOTION_PROMOTION_STARTED` etc — we
    // strip the double prefix for readability).
    if (action?.startsWith("PROMOTION_")) {
      const verb = action.replace(/^PROMOTION_(PROMOTION_)?/, "").toLowerCase();
      const promoId = md.promotionId ? String(md.promotionId).slice(0, 12) + "…" : "";
      if (verb === "created") return `Promotion created — ${promoId}`;
      if (verb === "started") return `Promotion started — ${promoId}`;
      if (verb === "paused") return `Promotion paused — ${promoId}`;
      if (verb === "resumed") return `Promotion resumed — ${promoId}`;
      if (verb === "retired") return `Promotion retired — ${promoId}`;
      if (verb === "edited") return `Promotion edited — ${promoId}`;
      if (verb === "duplicated") {
        const src = md.sourcePromotionId ? String(md.sourcePromotionId).slice(0, 12) + "…" : "";
        return src ? `Duplicated from ${src} → ${promoId}` : `Promotion duplicated — ${promoId}`;
      }
      if (verb === "dispatched") {
        const sent = md.sent ?? "?";
        const skipped = md.skipped ?? "?";
        return `Manual send burst — ${sent} sent, ${skipped} skipped`;
      }
      if (verb === "test_sent") {
        return `Test ${md.channel ?? ""} sent — ${promoId}`;
      }
      return `Promotion — ${promoId}`;
    }

    // Promo opt-out / opt-in — per-contact, per-channel. Metadata
    // includes { contactId, clientId, channel, source, reason? }.
    if (action?.startsWith("PROMO_OPT_")) {
      const channel = md.channel === "email" ? "email"
        : md.channel === "sms" ? "SMS"
        : md.channel ?? "";
      const source: Record<string, string> = {
        client_self_email_link: "clicked email link",
        client_self_sms_link: "clicked SMS link",
        client_self_invoice_page: "self-served on invoice page",
        super_manual: "Super manual",
        hard_bounce: "email hard bounce",
      };
      const src = source[md.source] ?? md.source ?? "";
      const direction = action === "PROMO_OPT_PROMO_OPTED_OUT" ? "opted OUT of" : "opted IN to";
      const suffix = md.reason ? ` — ${md.reason}` : src ? ` — ${src}` : "";
      return `Contact ${direction} ${channel}${suffix}`;
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
        History
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
          inputId="history-search"
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
                      title={fmtDateTime(row.createdAt)}
                      whiteSpace="nowrap"
                    >
                      {fmtDateTime(row.createdAt)}
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
          <Select.Root
            collection={pageSizeCollection}
            value={[String(pageSize)]}
            onValueChange={(e) => {
              const n = Number(e.value[0]);
              if (Number.isFinite(n) && n > 0) onChangePageSize(n);
            }}
            size="sm"
            positioning={{ strategy: "fixed", hideWhenDetached: true }}
            css={{ width: "auto", flex: "0 0 auto" }}
          >
            <Select.Control>
              <Select.Trigger w="auto" minW="0" px="2" title="Rows per page">
                <Select.ValueText />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {pageSizeCollection.items.map((it) => (
                  <Select.Item key={it.value} item={it.value}>
                    <Select.ItemText>{it.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select.Root>
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
