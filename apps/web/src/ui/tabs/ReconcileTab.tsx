"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Card, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiDownload, FiInfo } from "react-icons/fi";
import { ChevronDown, ChevronRight } from "lucide-react";
import { apiGet, apiDownload } from "@/src/lib/api";
import DateInput from "@/src/ui/components/DateInput";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import {
  bizToday,
  bizAddDays,
  bizMondayOnOrBefore,
  bizStartOfMonth,
  bizStartOfYear,
} from "@/src/lib/lib";

/**
 * Money → Reconcile tab. Replaces the old Exports + P&L Report tabs.
 *
 * Three things on one page:
 *   1. A QB-style Profit & Loss for the selected date range.
 *   2. Click any line in the P&L to drill down into the underlying rows.
 *   3. Three flat CSVs (Capital, Income, Expenses) for reconciliation
 *      against whichever accounting software the operator uses as their
 *      source of truth.
 *
 * No history. No saved downloads. No bundles. The CSVs are pure
 * reconciliation aids the operator scans against the accounting
 * software's bank-fed entries.
 */

type PnLRow = { qbAccount: string; total: number };
type PnLExpenseGroup = {
  parent: string;
  directTotal: number;
  children: PnLRow[];
  subtotal: number;
};
type PnLBucket = { groups: PnLExpenseGroup[]; flat: PnLRow[]; total: number };
type PnLReport = {
  range: { from: string; to: string };
  income: { rows: PnLRow[]; total: number };
  cogs: PnLBucket;
  grossProfit: number;
  expenses: PnLBucket;
  netOperatingIncome: number;
};

type PnLDetailRow = {
  date: string;
  primary: string;
  secondary?: string;
  amount: number;
};
type PnLDetail = {
  qbAccount: string;
  rows: PnLDetailRow[];
  total: number;
};
type DetailState = PnLDetail | "loading" | { error: string };

function fmtUSD(n: number): string {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−$${formatted}` : `$${formatted}`;
}

function leafName(qbAccount: string): string {
  const colon = qbAccount.indexOf(":");
  return colon < 0 ? qbAccount : qbAccount.slice(colon + 1).trim();
}

export default function ReconcileTab() {
  const thisMondayDefault = bizMondayOnOrBefore();
  const [start, setStart] = useState(thisMondayDefault);
  const [end, setEnd] = useState(bizAddDays(thisMondayDefault, 6));
  const [report, setReport] = useState<PnLReport | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-qbAccount expand state + cached details. Cleared whenever the
  // date range changes (the rows would no longer match the report).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  // Independent loading state for the CSV downloads so we can disable
  // the right button while its file is streaming.
  const [downloading, setDownloading] = useState<"capital" | "income" | "expenses" | "workdays" | null>(null);
  // Active preset key + dropdown visibility for the green-chip preset
  // picker (matching PaymentsTab + Ledger). `null` means the operator
  // typed the dates by hand — the chip reads "Custom dates".
  const [selectedPreset, setSelectedPreset] = useState<string | null>("this-week");
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);

  const load = useCallback(async () => {
    if (!start || !end) return;
    setLoading(true);
    try {
      const r = await apiGet<PnLReport>(`/api/admin/business-expenses/pnl-report?from=${start}&to=${end}`);
      setReport(r);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load the report.", err) });
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  // Date-range change → drop any expanded drill-downs. Their rows
  // belonged to the previous window and would now disagree with the
  // section totals on screen.
  useEffect(() => {
    setExpanded(new Set());
    setDetails({});
  }, [start, end]);

  async function toggleAccount(qbAccount: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(qbAccount)) {
        next.delete(qbAccount);
        return next;
      }
      next.add(qbAccount);
      const cached = details[qbAccount];
      if (!cached || (typeof cached === "object" && "error" in cached)) {
        setDetails((d) => ({ ...d, [qbAccount]: "loading" }));
        apiGet<PnLDetail>(
          `/api/admin/business-expenses/pnl-report/details?from=${start}&to=${end}&qbAccount=${encodeURIComponent(qbAccount)}`,
        )
          .then((data) => setDetails((d) => ({ ...d, [qbAccount]: data })))
          .catch((err: any) =>
            setDetails((d) => ({ ...d, [qbAccount]: { error: err?.message ?? "Failed to load details" } })),
          );
      }
      return next;
    });
  }

  async function downloadCsv(kind: "capital" | "income" | "expenses" | "workdays") {
    if (downloading) return;
    setDownloading(kind);
    try {
      await apiDownload(
        `/api/admin/exports/${kind}.csv?start=${start}&end=${end}`,
        `${kind}-${start}_${end}.csv`,
      );
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Failed to download ${kind} CSV.`, err),
      });
    } finally {
      setDownloading(null);
    }
  }

  const presets = useMemo(
    () => [
      {
        key: "last-week",
        label: "Last week",
        range: () => {
          const lastMon = bizAddDays(bizMondayOnOrBefore(), -7);
          return { from: lastMon, to: bizAddDays(lastMon, 6) };
        },
      },
      {
        key: "this-week",
        label: "This week",
        range: () => {
          const mon = bizMondayOnOrBefore();
          return { from: mon, to: bizAddDays(mon, 6) };
        },
      },
      {
        key: "last-month",
        label: "Last month",
        range: () => {
          const thisMonthStart = bizStartOfMonth();
          const lastMonthEnd = bizAddDays(thisMonthStart, -1);
          const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
          return { from: lastMonthStart, to: lastMonthEnd };
        },
      },
      {
        key: "this-month",
        label: "This month",
        range: () => {
          const startStr = bizStartOfMonth();
          const [y, m] = startStr.split("-").map(Number);
          const nextMonthStart = m === 12
            ? `${y + 1}-01-01`
            : `${y}-${String(m + 1).padStart(2, "0")}-01`;
          const endStr = bizAddDays(nextMonthStart, -1);
          return { from: startStr, to: endStr };
        },
      },
      { key: "ytd", label: "Year to date", range: () => ({ from: bizStartOfYear(), to: bizToday() }) },
    ],
    [],
  );

  const grossProfitPct = report && report.income.total > 0
    ? Math.round((report.grossProfit / report.income.total) * 1000) / 10
    : null;

  return (
    <VStack align="stretch" gap={4}>
      {/* Informational banner — explains the reconciliation use case. */}
      <Box p={3} bg="blue.50" borderLeftWidth="3px" borderColor="blue.400" borderRadius="md">
        <HStack align="flex-start" gap={2}>
          <Box pt={0.5}><FiInfo /></Box>
          <VStack align="stretch" gap={1} flex="1" minW={0}>
            <Text fontSize="sm" fontWeight="semibold" color="blue.900">
              Use this tab to validate against your accounting software
            </Text>
            <Text fontSize="xs" color="blue.900">
              Your accounting software is the source of truth (wired directly to the bank). This view is a quick scan: pick a date range, eyeball the P&L against your accounting software&apos;s Profit and Loss report, and download a flat CSV when you need a side-by-side check of capital activity, income, or expenses. Every P&L line expands to show the underlying rows.
            </Text>
          </VStack>
        </HStack>
      </Box>

      {/* Date range picker + presets. */}
      <Card.Root>
        <Card.Body>
          <VStack align="stretch" gap={3}>
            {/* Timeframe row — DateInput + dash + DateInput + green preset
                chip on a single line, matching the PaymentsTab layout. */}
            <HStack gap={2} wrap="wrap" align="center">
              <DateInput
                value={start}
                onChange={(val) => {
                  setSelectedPreset(null);
                  setStart(val);
                  if (end && val && val > end) setEnd(val);
                }}
              />
              <Text fontSize="sm">–</Text>
              <DateInput
                value={end}
                min={start || undefined}
                onChange={(val) => {
                  setSelectedPreset(null);
                  setEnd(val);
                  if (start && val && val < start) setStart(val);
                }}
              />
              {/* Preset picker — green chip + dropdown, matching PaymentsTab
                  and Ledger. Clicking the chip toggles a popover with every
                  preset; the active preset's label fills the chip when one
                  is selected, otherwise "Custom dates". */}
              <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
                <Badge
                  size="sm"
                  colorPalette="green"
                  variant="subtle"
                  cursor="pointer"
                  onClick={() => setQuickDateMenuOpen((v) => !v)}
                >
                  {selectedPreset
                    ? presets.find((p) => p.key === selectedPreset)?.label ?? "Custom dates"
                    : "Custom dates"}
                  {" "}
                  <Box
                    as="span"
                    display="inline-flex"
                    alignItems="center"
                    justifyContent="center"
                    w="14px"
                    h="14px"
                    borderRadius="full"
                    bg="green.500"
                    color="white"
                    verticalAlign="middle"
                  >
                    <ChevronDown size={9} />
                  </Box>
                </Badge>
                {quickDateMenuOpen && (
                  <VStack
                    position="fixed"
                    bg="white"
                    borderWidth="1px"
                    borderColor="gray.200"
                    rounded="md"
                    shadow="lg"
                    zIndex={10000}
                    p={1}
                    gap={0}
                    minW="160px"
                    ref={(el: HTMLDivElement | null) => {
                      if (el && el.parentElement) {
                        const rect = el.parentElement.getBoundingClientRect();
                        el.style.top = `${rect.bottom + 4}px`;
                        el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 168))}px`;
                      }
                    }}
                  >
                    {presets.map((p) => (
                      <Button
                        key={p.key}
                        size="xs"
                        variant={selectedPreset === p.key ? "solid" : "ghost"}
                        colorPalette={selectedPreset === p.key ? "green" : undefined}
                        w="full"
                        justifyContent="start"
                        onClick={() => {
                          setQuickDateMenuOpen(false);
                          setSelectedPreset(p.key);
                          const r = p.range();
                          setStart(r.from);
                          setEnd(r.to);
                        }}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </VStack>
                )}
              </Box>
            </HStack>
            {/* By-category chip strip — same look as the Ledger tab. Sits
                directly under the timeframe so the operator sees the spend
                breakdown at a glance before scrolling into the P&L table. */}
            {report && <ExpenseCategoryChips report={report} />}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* P&L Report rendering with expand/collapse. */}
      <Card.Root>
        <Card.Body>
          {loading && !report ? (
            <HStack justify="center" py={6}><Spinner /></HStack>
          ) : !report ? (
            <Text fontSize="sm" color="fg.muted">Pick a date range to view the report.</Text>
          ) : (
            <VStack align="stretch" gap={0}>
              <Box textAlign="center" pb={3}>
                <Text fontSize="md" fontWeight="bold">Profit and Loss</Text>
                <Text fontSize="xs" color="fg.muted">
                  {report.range.from} → {report.range.to}
                </Text>
              </Box>

              {/* Income */}
              <SectionHeader label="Income" />
              {report.income.rows.length === 0 ? (
                <EmptyRow label="No income in this range." />
              ) : (
                report.income.rows.map((r) => (
                  <ExpandableRow
                    key={r.qbAccount}
                    label={r.qbAccount}
                    amount={r.total}
                    indent={1}
                    expanded={expanded.has(r.qbAccount)}
                    onToggle={() => void toggleAccount(r.qbAccount)}
                    detailState={details[r.qbAccount]}
                  />
                ))
              )}
              <TotalRow label="Total Income" amount={report.income.total} />

              {/* COGS */}
              {(report.cogs.flat.length > 0 || report.cogs.groups.length > 0) && (
                <>
                  <SectionHeader label="Cost of Goods Sold" />
                  <BucketRows bucket={report.cogs} expanded={expanded} details={details} onToggle={toggleAccount} />
                  <TotalRow label="Total Cost of Goods Sold" amount={report.cogs.total} />
                </>
              )}

              {/* Gross Profit */}
              <HStack
                justify="space-between"
                px={3}
                py={2}
                bg="gray.50"
                borderTopWidth="1px"
                borderColor="gray.200"
              >
                <HStack gap={2}>
                  <Text fontSize="sm" fontWeight="bold">Gross Profit</Text>
                  {grossProfitPct !== null && (
                    <Text fontSize="xs" color="fg.muted">({grossProfitPct}%)</Text>
                  )}
                </HStack>
                <Text fontSize="sm" fontWeight="bold" color={report.grossProfit < 0 ? "red.600" : "fg.default"}>
                  {fmtUSD(report.grossProfit)}
                </Text>
              </HStack>

              {/* Expenses */}
              {(report.expenses.flat.length > 0 || report.expenses.groups.length > 0) && (
                <>
                  <SectionHeader label="Expenses" />
                  <BucketRows bucket={report.expenses} expanded={expanded} details={details} onToggle={toggleAccount} />
                  <TotalRow label="Total Expenses" amount={report.expenses.total} />
                </>
              )}

              {/* Net Operating Income */}
              <HStack
                justify="space-between"
                px={3}
                py={2.5}
                bg={report.netOperatingIncome < 0 ? "red.50" : "green.50"}
                borderTopWidth="2px"
                borderColor="gray.300"
                mt={2}
              >
                <Text fontSize="md" fontWeight="bold">Net Operating Income</Text>
                <Text
                  fontSize="md"
                  fontWeight="bold"
                  color={report.netOperatingIncome < 0 ? "red.600" : "green.700"}
                >
                  {fmtUSD(report.netOperatingIncome)}
                </Text>
              </HStack>
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      {/* CSV downloads — two flat files for QB cross-checks. */}
      <Card.Root>
        <Card.Body>
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm" fontWeight="medium">Download CSV</Text>
            <Text fontSize="xs" color="fg.muted">
              Files for cross-checking against accounting software to reconcile accounts.
            </Text>
            <HStack gap={2} wrap="wrap">
              <Button
                size="sm"
                colorPalette="blue"
                onClick={() => void downloadCsv("capital")}
                disabled={downloading !== null || loading}
              >
                {downloading === "capital" ? <Spinner size="xs" /> : <FiDownload />}
                <Text ml={2}>Capital</Text>
              </Button>
              <Button
                size="sm"
                colorPalette="blue"
                onClick={() => void downloadCsv("income")}
                disabled={downloading !== null || loading}
              >
                {downloading === "income" ? <Spinner size="xs" /> : <FiDownload />}
                <Text ml={2}>Income</Text>
              </Button>
              <Button
                size="sm"
                colorPalette="blue"
                onClick={() => void downloadCsv("expenses")}
                disabled={downloading !== null || loading}
              >
                {downloading === "expenses" ? <Spinner size="xs" /> : <FiDownload />}
                <Text ml={2}>Expenses</Text>
              </Button>
              <Button
                size="sm"
                colorPalette="blue"
                onClick={() => void downloadCsv("workdays")}
                disabled={downloading !== null || loading}
              >
                {downloading === "workdays" ? <Spinner size="xs" /> : <FiDownload />}
                <Text ml={2}>Workdays</Text>
              </Button>
            </HStack>
            <Box as="ul" fontSize="xs" color="fg.muted" pl={5} m={0} css={{ listStyleType: "disc" }}>
              <Box as="li" mb={1}>
                <b>Capital</b> — capital contributions (owner money in) and owner draws (owner money out). Equity entries — match against the equity accounts in your accounting software.
              </Box>
              <Box as="li" mb={1}>
                <b>Income</b> — every inflow in the window: each worker&apos;s share of every service payment, the owner&apos;s cut back to the business, and equipment rental income. Includes gross / processor fee / net per payment so you can match against deposit entries.
              </Box>
              <Box as="li" mb={1}>
                <b>Expenses</b> — operating business expenses (the P&amp;L side) in the selected window. Use to validate spend categories against your accounting software.
              </Box>
              <Box as="li">
                <b>Workdays</b> — one row per worker per workday in the window: start / end times, paused minutes, active hours, and approval status. Use to reconcile against Gusto payroll hours.
              </Box>
            </Box>
          </VStack>
        </Card.Body>
      </Card.Root>

      <Text fontSize="xs" color="fg.muted">
        Cash basis. ET-anchored date boundaries. Excludes fixed-asset purchases (capitalized to balance sheet) and uncompleted future-dated jobs.
      </Text>
    </VStack>
  );
}

// ── Render helpers ───────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <HStack
      px={3}
      py={2}
      bg="gray.200"
      borderTopWidth="1px"
      borderColor="gray.300"
    >
      <Text fontSize="sm" fontWeight="semibold">{label}</Text>
    </HStack>
  );
}

type BucketEntry =
  | { kind: "flat"; key: string; row: PnLRow }
  | { kind: "group"; key: string; group: PnLExpenseGroup };

function mergeBucketEntries(bucket: { groups: PnLExpenseGroup[]; flat: PnLRow[] }): BucketEntry[] {
  const entries: BucketEntry[] = [];
  for (const r of bucket.flat) entries.push({ kind: "flat", key: r.qbAccount, row: r });
  for (const g of bucket.groups) entries.push({ kind: "group", key: g.parent, group: g });
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

function BucketRows({
  bucket,
  expanded,
  details,
  onToggle,
}: {
  bucket: PnLBucket;
  expanded: Set<string>;
  details: Record<string, DetailState>;
  onToggle: (qbAccount: string) => void;
}) {
  return (
    <>
      {mergeBucketEntries(bucket).map((entry) =>
        entry.kind === "flat" ? (
          <ExpandableRow
            key={`flat:${entry.row.qbAccount}`}
            label={entry.row.qbAccount}
            amount={entry.row.total}
            indent={1}
            expanded={expanded.has(entry.row.qbAccount)}
            onToggle={() => onToggle(entry.row.qbAccount)}
            detailState={details[entry.row.qbAccount]}
          />
        ) : (
          <Box key={`group:${entry.group.parent}`}>
            {/* Parent row — expandable only if the parent has a non-zero
                direct total of its own (i.e. expenses tagged at the
                parent level, not just at children). When the direct
                total is zero, the parent is purely a header and there's
                no underlying detail to drill into. */}
            {entry.group.directTotal !== 0 ? (
              <ExpandableRow
                label={entry.group.parent}
                amount={entry.group.directTotal}
                indent={1}
                bold
                expanded={expanded.has(entry.group.parent)}
                onToggle={() => onToggle(entry.group.parent)}
                detailState={details[entry.group.parent]}
              />
            ) : (
              <HStack justify="space-between" pl={6} pr={3} py={1.5}>
                <Text fontSize="sm" fontWeight="semibold">{entry.group.parent}</Text>
              </HStack>
            )}
            {entry.group.children.map((c) => (
              <ExpandableRow
                key={c.qbAccount}
                label={leafName(c.qbAccount)}
                amount={c.total}
                indent={2}
                expanded={expanded.has(c.qbAccount)}
                onToggle={() => onToggle(c.qbAccount)}
                detailState={details[c.qbAccount]}
              />
            ))}
            <HStack
              justify="space-between"
              pl={6}
              pr={3}
              py={1.5}
              borderTopWidth="1px"
              borderColor="gray.100"
            >
              <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                Total for {entry.group.parent}
              </Text>
              <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                {fmtUSD(entry.group.subtotal)}
              </Text>
            </HStack>
          </Box>
        ),
      )}
    </>
  );
}

function ExpandableRow({
  label,
  amount,
  indent,
  bold = false,
  expanded,
  onToggle,
  detailState,
}: {
  label: string;
  amount: number;
  indent: 1 | 2;
  bold?: boolean;
  expanded: boolean;
  onToggle: () => void;
  detailState: DetailState | undefined;
}) {
  const pl = indent === 1 ? 6 : 10;
  return (
    <Box>
      <HStack
        as="button"
        onClick={onToggle}
        justify="space-between"
        w="full"
        pl={pl}
        pr={3}
        py={1.5}
        textAlign="left"
        bg="transparent"
        _hover={{ bg: "blackAlpha.50" }}
        cursor="pointer"
        aria-expanded={expanded}
      >
        <HStack gap={1} flex="1" minW={0}>
          <Box color="fg.muted" flexShrink={0}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </Box>
          <Text fontSize="sm" fontWeight={bold ? "semibold" : undefined}>{label}</Text>
        </HStack>
        <Text fontSize="sm" fontWeight={bold ? "semibold" : undefined} color={amount < 0 ? "red.600" : undefined}>
          {fmtUSD(amount)}
        </Text>
      </HStack>
      {expanded && (
        <Box pl={pl + 2} pr={3} pb={2} pt={1}>
          <DetailRows state={detailState} />
        </Box>
      )}
    </Box>
  );
}

function DetailRows({ state }: { state: DetailState | undefined }) {
  if (state === undefined || state === "loading") {
    return (
      <HStack color="fg.muted" fontSize="xs" py={2}>
        <Spinner size="xs" />
        <Text>Loading details…</Text>
      </HStack>
    );
  }
  if (typeof state === "object" && "error" in state) {
    return <Text fontSize="xs" color="red.600">{state.error}</Text>;
  }
  if (state.rows.length === 0) {
    return <Text fontSize="xs" color="fg.muted" fontStyle="italic">(no underlying rows)</Text>;
  }
  return (
    <VStack
      align="stretch"
      gap={0}
      fontSize="xs"
      borderLeftWidth="2px"
      borderColor="gray.200"
      pl={3}
    >
      {state.rows.map((r, i) => (
        <HStack
          key={i}
          justify="space-between"
          gap={2}
          py={0.5}
          borderBottomWidth="1px"
          borderColor="gray.100"
        >
          <HStack gap={2} flex="1" minW={0}>
            {r.date && (
              <Text color="fg.muted" fontFamily="mono" flexShrink={0} minW="78px">
                {r.date}
              </Text>
            )}
            <VStack align="start" gap={0} flex="1" minW={0}>
              <Text>{r.primary}</Text>
              {r.secondary && (
                <Text color="fg.muted" fontSize="2xs">{r.secondary}</Text>
              )}
            </VStack>
          </HStack>
          <Text fontWeight="medium" flexShrink={0}>
            {fmtUSD(r.amount)}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
}

function TotalRow({ label, amount }: { label: string; amount: number }) {
  return (
    <HStack
      justify="space-between"
      px={3}
      py={1.5}
      borderTopWidth="1px"
      borderColor="gray.200"
      bg="gray.50"
    >
      <Text fontSize="sm" fontWeight="bold">{label}</Text>
      <Text fontSize="sm" fontWeight="bold" color={amount < 0 ? "red.600" : undefined}>
        {fmtUSD(amount)}
      </Text>
    </HStack>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <Text fontSize="xs" color="fg.muted" pl={6} py={2}>{label}</Text>
  );
}

/**
 * At-a-glance chips of the P&L's COGS + Expenses lines sorted by amount
 * descending. Mirrors the by-category chip view on the Ledger tab so the
 * operator can scan "where did money go" without re-reading the full
 * P&L table. Computed from the report (no extra fetch); skipped when
 * nothing's there.
 */
function ExpenseCategoryChips({ report }: { report: PnLReport }) {
  const items: { label: string; amount: number }[] = [];
  // Flatten both buckets — flat rows + each group's parent direct + its
  // children — into a single list keyed by qbAccount.
  function pushBucket(bucket: PnLBucket) {
    for (const r of bucket.flat) items.push({ label: r.qbAccount, amount: r.total });
    for (const g of bucket.groups) {
      if (g.directTotal !== 0) items.push({ label: g.parent, amount: g.directTotal });
      for (const c of g.children) items.push({ label: c.qbAccount, amount: c.total });
    }
  }
  pushBucket(report.cogs);
  pushBucket(report.expenses);
  if (items.length === 0) return null;
  items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return (
    <Box>
      <Text fontSize="xs" color="fg.muted" mb={1.5}>By Category</Text>
      <HStack gap={2} wrap="wrap">
        {items.map((it) => (
          <Badge key={it.label} size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="2">
            {it.label}: {fmtUSD(it.amount)}
          </Badge>
        ))}
      </HStack>
    </Box>
  );
}
