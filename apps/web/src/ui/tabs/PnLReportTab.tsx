"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Card, HStack, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiInfo } from "react-icons/fi";
import { apiGet } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";

/**
 * P&L Report tab — structured Profit & Loss view for a selectable date
 * range, designed to be reconciled side-by-side with QuickBooks Online's
 * Profit and Loss report.
 *
 * The backend (apps/api/src/services/pnlReport.ts) builds this from the same
 * source data the QB Income + QB Expenses CSVs use, with identical filters
 * (confirmed payments only, !writtenOff, ET-anchored boundaries, fixed
 * assets capitalized off the P&L). Section grouping (COGS vs Operating
 * Expense) is config-driven via the EXPENSE_CATEGORIES taxonomy's
 * plSection field; QB-style "parent:child" account names render as
 * grouped subtotals.
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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function mondayOnOrBefore(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + delta);
  return x;
}
function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
function ytdRange(): { from: string; to: string } {
  const today = new Date();
  return { from: `${today.getFullYear()}-01-01`, to: dateKey(today) };
}

function fmtUSD(n: number): string {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−$${formatted}` : `$${formatted}`;
}

// Strip the "parent:" prefix from a child qbAccount so the rendered leaf
// name doesn't repeat the parent ("Other business expenses:Payment
// processing fees" → "Payment processing fees").
function leafName(qbAccount: string): string {
  const colon = qbAccount.indexOf(":");
  return colon < 0 ? qbAccount : qbAccount.slice(colon + 1).trim();
}

export default function PnLReportTab() {
  // Default to this calendar week's Mon–Sun, matching the Exports tab default.
  const thisMondayDefault = mondayOnOrBefore(new Date());
  const thisSundayDefault = addDays(thisMondayDefault, 6);
  const [start, setStart] = useState(dateKey(thisMondayDefault));
  const [end, setEnd] = useState(dateKey(thisSundayDefault));
  const [report, setReport] = useState<PnLReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!start || !end) return;
    setLoading(true);
    try {
      const r = await apiGet<PnLReport>(`/api/admin/business-expenses/pnl-report?from=${start}&to=${end}`);
      setReport(r);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load the P&L report.", err) });
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  // Auto-load on mount + whenever the date range changes.
  useEffect(() => {
    void load();
  }, [load]);

  const presets = useMemo(
    () => [
      {
        key: "last-week",
        label: "Last week",
        range: () => {
          const thisMon = mondayOnOrBefore(new Date());
          const lastMon = addDays(thisMon, -7);
          return { from: dateKey(lastMon), to: dateKey(addDays(lastMon, 6)) };
        },
      },
      {
        key: "this-week",
        label: "This week",
        range: () => ({
          from: dateKey(mondayOnOrBefore(new Date())),
          to: dateKey(addDays(mondayOnOrBefore(new Date()), 6)),
        }),
      },
      {
        key: "last-month",
        label: "Last month",
        range: () => {
          // First → last calendar day of the previous month. Day 0 of the
          // current month resolves to the last day of the prior month
          // (handles 28/29/30/31 correctly without per-month branching).
          const today = new Date();
          const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
          const end = new Date(today.getFullYear(), today.getMonth(), 0);
          return { from: dateKey(start), to: dateKey(end) };
        },
      },
      {
        key: "this-month",
        label: "This month",
        range: () => {
          // First → last calendar day of the current month. The end uses
          // day 0 of the NEXT month, which JS resolves to the last day of
          // the current month (handles month-length variation automatically).
          const today = new Date();
          const start = new Date(today.getFullYear(), today.getMonth(), 1);
          const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
          return { from: dateKey(start), to: dateKey(end) };
        },
      },
      { key: "ytd", label: "Year to date", range: ytdRange },
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
              Use this report to reconcile against QuickBooks
            </Text>
            <Text fontSize="xs" color="blue.900">
              Pull the same date range in QB (<b>Reports → Profit and Loss</b>, <b>Cash basis</b>) and compare line by line. Every row, subtotal, and section total here should match QB's P&L for the same period. Differences typically mean a CSV row failed to import, a duplicate landed in QB, or a category was reassigned in only one place.
            </Text>
          </VStack>
        </HStack>
      </Box>

      {/* Date range picker + presets. */}
      <Card.Root>
        <Card.Body>
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm" fontWeight="medium">Date range</Text>
            <HStack gap={2} wrap="wrap">
              <Box>
                <Text fontSize="xs" color="fg.muted" mb={1}>Start</Text>
                <Input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) { setStart(v); return; }
                    setStart(v);
                    if (end && v > end) setEnd(v);
                  }}
                  size="sm"
                  w="160px"
                />
              </Box>
              <Box>
                <Text fontSize="xs" color="fg.muted" mb={1}>End</Text>
                <Input
                  type="date"
                  value={end}
                  min={start || undefined}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) { setEnd(v); return; }
                    setEnd(v);
                    if (start && v < start) setStart(v);
                  }}
                  size="sm"
                  w="160px"
                />
              </Box>
            </HStack>
            <HStack gap={2} wrap="wrap">
              {presets.map((p) => (
                <Button
                  key={p.key}
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const r = p.range();
                    setStart(r.from);
                    setEnd(r.to);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </HStack>
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* P&L Report rendering. */}
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

              {/* Income section. */}
              <SectionHeader label="Income" />
              {report.income.rows.length === 0 ? (
                <EmptyRow label="No income in this range." />
              ) : (
                report.income.rows.map((r) => (
                  <Row key={r.qbAccount} label={r.qbAccount} amount={r.total} indent={1} />
                ))
              )}
              <TotalRow label="Total Income" amount={report.income.total} />

              {/* Cost of Goods Sold section — uses the same parent:child
                  grouping logic as Expenses so colon-delimited account
                  names like "Cost of goods sold:Direct supplies & materials"
                  render with proper indentation + subtotals. */}
              {(report.cogs.flat.length > 0 || report.cogs.groups.length > 0) && (
                <>
                  <SectionHeader label="Cost of Goods Sold" />
                  <BucketRows bucket={report.cogs} />
                  <TotalRow label="Total Cost of Goods Sold" amount={report.cogs.total} />
                </>
              )}

              {/* Gross Profit — shown even if zero so the layout matches QB. */}
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

              {/* Expenses section. Same render path as COGS via BucketRows. */}
              {(report.expenses.flat.length > 0 || report.expenses.groups.length > 0) && (
                <>
                  <SectionHeader label="Expenses" />
                  <BucketRows bucket={report.expenses} />
                  <TotalRow label="Total Expenses" amount={report.expenses.total} />
                </>
              )}

              {/* Net Operating Income — the bottom line. */}
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

      {/* Footer note. */}
      <Text fontSize="xs" color="fg.muted">
        Cash basis. ET-anchored date boundaries. Excludes fixed-asset purchases (capitalized to balance sheet), capital contributions, and owner draws.
      </Text>
    </VStack>
  );
}

// ── Render helpers ───────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  // Slightly darker than the rest of the table so section boundaries stand
  // out at a glance, without being heavy. TotalRow below each section and
  // the Gross Profit / NOI rows use the lighter bg="gray.50" tier.
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

/**
 * Render a P&L bucket (COGS or Operating Expenses) — flat rows + parent:child
 * grouped blocks, alphabetized across both. Used by both sections so the
 * colon-parsed hierarchy behaves identically.
 */
function BucketRows({ bucket }: { bucket: PnLBucket }) {
  return (
    <>
      {mergeBucketEntries(bucket).map((entry) =>
        entry.kind === "flat" ? (
          <Row key={`flat:${entry.row.qbAccount}`} label={entry.row.qbAccount} amount={entry.row.total} indent={1} />
        ) : (
          <Box key={`group:${entry.group.parent}`}>
            <Row
              label={entry.group.parent}
              amount={entry.group.directTotal}
              indent={1}
              showAmount={entry.group.directTotal !== 0}
              bold
            />
            {entry.group.children.map((c) => (
              <Row
                key={c.qbAccount}
                label={leafName(c.qbAccount)}
                amount={c.total}
                indent={2}
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

function Row({
  label,
  amount,
  indent,
  showAmount = true,
  bold = false,
}: {
  label: string;
  amount: number;
  indent: 1 | 2;
  showAmount?: boolean;
  bold?: boolean;
}) {
  const pl = indent === 1 ? 6 : 10;
  return (
    <HStack justify="space-between" pl={pl} pr={3} py={1.5}>
      <Text fontSize="sm" fontWeight={bold ? "semibold" : undefined}>{label}</Text>
      {showAmount && (
        <Text fontSize="sm" fontWeight={bold ? "semibold" : undefined} color={amount < 0 ? "red.600" : undefined}>
          {fmtUSD(amount)}
        </Text>
      )}
    </HStack>
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

// Interleave flat rows + grouped rows from a P&L bucket (COGS or Expenses)
// into one alphabetically-sorted list. The backend already sorts each
// subset; this is just a zipper-merge so the rendered section reads in
// strict alphabetical order at the top level regardless of which entries
// happen to have children.
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
