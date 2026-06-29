"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Box, Button, Card, HStack, Select, Spinner, Table, Text, VStack, createListCollection } from "@chakra-ui/react";
import { FiDownload, FiInfo } from "react-icons/fi";
import { ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
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
  /** Categories explicitly opted out of the P&L. Visibility-only —
   *  the dollars here do NOT roll into expenses or netOperatingIncome.
   *  Surfaced in a dedicated section at the bottom so the operator can
   *  confirm every Ledger entry is accounted for somewhere. */
  excluded: PnLBucket;
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

// ── Worker reconciliation (period) types — sourced from /api/super/reconcile/period
//
// Previously rendered in a standalone "Workers Reconcile" tab; folded
// into this surface so the P&L and the per-worker drill-downs share
// a single date range and a single page.
type WorkerJobRow = {
  occurrenceId: string;
  title: string;
  client: string | null;
  property: string | null;
  completedAt: string | null;
  grossShare: number;
  feeOrMargin: number;
  topUp: number;
  netPaid: number;
  paymentConfirmed: boolean;
  paymentWrittenOff: boolean;
  source: "snapshot" | "computed";
};

type WorkerDayRow = {
  date: string;
  hoursActive: number;
  jobsCompleted: number;
  grossEarnings: number;
  feesOrMargin: number;
  topUps: number;
  netPaid: number;
  /** True when the worker's workday on this date hasn't ended yet —
   *  hoursActive is a live snapshot, not finalized. */
  inProgress: boolean;
  jobs: WorkerJobRow[];
};

type WorkerRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
  isOwner: boolean;
  hoursActive: number;
  daysWorked: number;
  jobsCompleted: number;
  grossEarnings: number;
  feesOrMargin: number;
  topUps: number;
  netPaid: number;
  ownerEarnings: number;
  effectiveHourly: number | null;
  preTopUpHourly: number | null;
  belowMinWage: boolean;
  /** True when the worker has at least one in-progress workday in
   *  the window. Headline hours include live elapsed time. */
  hasInProgressWorkday: boolean;
  anomalies: string[];
  days: WorkerDayRow[];
};

type Period = {
  range: { from: string; to: string };
  minWagePerHour: number;
  totals: {
    workersActive: number;
    totalHours: number;
    totalDaysLogged: number;
    totalJobsCompleted: number;
    totalRevenue: number;
    totalEquipmentRental: number;
    totalProcessorFees: number;
    totalWorkerGross: number;
    totalBusinessMargin: number;
    totalContractorFees: number;
    totalTopUps: number;
    totalWorkerNetPaid: number;
    totalOwnerEarnings: number;
    netOperatingIncome: number;
    anomalies: number;
  };
  reconciliationTargets: {
    gustoEmployeeWages: number;
    qbServiceIncome: number;
    qbEquipmentRentalIncome: number;
    qbProcessorFees: number;
    qbContractLabor: number;
  };
  workers: WorkerRow[];
  payroll: PayrollRow[];
};

type PayrollRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
  isOwner: boolean;
  hours: number;
  hourlyWage: number;
  regularWages: number;
  additionalEarnings: number;
  totalGross: number;
  equivalentHourlyRate: number | null;
};

function fmtUSD(n: number): string {
  // Accounting / P&L convention: negatives render as `($30.45)`
  // rather than `−$30.45`. Easier to spot at a glance in a column of
  // figures and matches how QuickBooks displays the same numbers.
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${formatted})` : `$${formatted}`;
}

function leafName(qbAccount: string): string {
  const colon = qbAccount.indexOf(":");
  return colon < 0 ? qbAccount : qbAccount.slice(colon + 1).trim();
}

function workerTypeLabel(t: string | null | undefined, isOwner: boolean): string {
  // LLC owner takes draws, not W-2 wages — surface that distinction
  // in the badge so the operator doesn't accidentally try to run the
  // owner through Gusto payroll.
  if (isOwner) return "Owner";
  switch (t) {
    case "EMPLOYEE": return "Employee";
    case "TRAINEE": return "Trainee";
    case "CONTRACTOR": return "Contractor";
    default: return "Unclassified";
  }
}

function workerTypePalette(t: string | null | undefined, isOwner: boolean): string {
  if (isOwner) return "orange";
  switch (t) {
    case "EMPLOYEE": return "blue";
    case "TRAINEE": return "purple";
    case "CONTRACTOR": return "green";
    default: return "gray";
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    publishInlineMessage({ type: "SUCCESS", text: `Copied: ${text}` });
  } catch {
    publishInlineMessage({ type: "ERROR", text: "Copy failed — clipboard unavailable." });
  }
}

export default function ReconcileTab() {
  const thisMondayDefault = bizMondayOnOrBefore();
  const [start, setStart] = useState(thisMondayDefault);
  const [end, setEnd] = useState(bizAddDays(thisMondayDefault, 6));
  const [report, setReport] = useState<PnLReport | null>(null);
  const [loading, setLoading] = useState(false);
  // Period (worker-side) state — fetched in parallel with the P&L
  // from the same date range. Drives the Period Summary,
  // Reconciliation Targets, and per-worker drill-downs at the bottom
  // of the page (folded in from the old Workers Reconcile tab).
  const [period, setPeriod] = useState<Period | null>(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  // Per-worker expand state for the worker drill-downs.
  const [expandedWorkers, setExpandedWorkers] = useState<Set<string>>(new Set());
  const [expandedWorkerDays, setExpandedWorkerDays] = useState<Set<string>>(new Set());
  // Per-qbAccount expand state + cached details. Cleared whenever the
  // date range changes (the rows would no longer match the report).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  // Independent loading state for the CSV downloads so we can disable
  // the right button while its file is streaming.
  // `downloading` doubles as a busy flag AND a progress label. Single-
  // CSV downloads stamp the exact kind so only that button spins; the
  // "Download All" path stamps "all" so both buttons disable together
  // while the sequential fetch loop runs.
  const [downloading, setDownloading] = useState<"capital" | "income" | "expenses" | "workdays" | "payroll" | "all" | null>(null);
  const [downloadAllProgress, setDownloadAllProgress] = useState<{ done: number; total: number } | null>(null);
  // Active selection in the download-type dropdown. Drives both the
  // Download button and the informational description below it.
  // Default to "payroll" since it's the freshest export — operator
  // can switch to any other type without leaving the section.
  const [downloadKind, setDownloadKind] = useState<"capital" | "income" | "expenses" | "workdays" | "payroll">("payroll");
  // Active preset key + dropdown visibility for the green-chip preset
  // picker (matching PaymentsTab + Ledger). `null` means the operator
  // typed the dates by hand — the chip reads "Custom dates".
  const [selectedPreset, setSelectedPreset] = useState<string | null>("this-week");
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);
  // Top-of-page info banner — collapsed by default so the page opens to
  // the dates + P&L; click the header to expand the explanation.
  const [infoExpanded, setInfoExpanded] = useState(false);
  // Per-section collapse state. ALL collapsed by default — the page
  // opens to a tight list of section headers so the operator can pick
  // which sections to dig into. Timeframe is not in this map — it's
  // intentionally always visible since picking the date range is the
  // entry point for everything below.
  const SECTION_KEYS = useMemo(
    () => ["download", "pnl", "payroll", "workers"] as const,
    [],
  );
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SECTION_KEYS.map((k) => [k, true])),
  );
  const toggleSection = (key: string) =>
    setSectionCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const isSectionCollapsed = (key: string) => !!sectionCollapsed[key];
  const expandAllSections = () =>
    setSectionCollapsed(Object.fromEntries(SECTION_KEYS.map((k) => [k, false])));
  const collapseAllSections = () =>
    setSectionCollapsed(Object.fromEntries(SECTION_KEYS.map((k) => [k, true])));
  const allExpanded = SECTION_KEYS.every((k) => !sectionCollapsed[k]);
  const allCollapsed = SECTION_KEYS.every((k) => !!sectionCollapsed[k]);

  // Monotonic request token. Each load() bumps this; the resolved
  // fetches check that their token still matches the latest before
  // calling setReport / setPeriod. Prevents an in-flight fetch from
  // an old date range overwriting a newer load.
  const requestTokenRef = useRef(0);

  const load = useCallback(async () => {
    if (!start || !end) return;
    const token = ++requestTokenRef.current;
    setLoading(true);
    setPeriodLoading(true);
    // Run both fetches in parallel so the user doesn't wait on one to
    // start the other. Each failure surfaces its own toast — the
    // other side still renders if available. Each handler guards on
    // the request token so a stale response can't clobber the latest.
    const pnlPromise = apiGet<PnLReport>(`/api/admin/business-expenses/pnl-report?from=${start}&to=${end}`)
      .then((r) => {
        if (token === requestTokenRef.current) setReport(r);
      })
      .catch((err) => {
        if (token === requestTokenRef.current) {
          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load the P&L.", err) });
        }
      })
      .finally(() => {
        if (token === requestTokenRef.current) setLoading(false);
      });
    const periodPromise = apiGet<Period>(`/api/super/reconcile/period?from=${start}&to=${end}`)
      .then((p) => {
        if (token === requestTokenRef.current) setPeriod(p);
      })
      .catch((err) => {
        if (token === requestTokenRef.current) {
          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load period totals.", err) });
        }
      })
      .finally(() => {
        if (token === requestTokenRef.current) setPeriodLoading(false);
      });
    await Promise.all([pnlPromise, periodPromise]);
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  // Date-range change → clear ALL window-scoped state synchronously so
  // the operator never sees stale numbers belonging to the prior
  // window. The fetches kicked off by `load` re-populate fresh.
  useEffect(() => {
    setReport(null);
    setPeriod(null);
    setExpanded(new Set());
    setDetails({});
    setExpandedWorkers(new Set());
    setExpandedWorkerDays(new Set());
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

  async function downloadCsv(kind: "capital" | "income" | "expenses" | "workdays" | "payroll") {
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

  // Fetches all five exports for the selected date range, one at a
  // time. Sequential because triggering five blob-anchor clicks at
  // once tends to get browser-blocked after the first two; serial
  // gives every file a clean user-gesture chain via the running
  // promise. Failures on any single CSV log a toast and continue with
  // the remaining files instead of aborting the whole batch.
  async function downloadAllCsvs() {
    if (downloading) return;
    const kinds: ("capital" | "income" | "expenses" | "workdays" | "payroll")[] = [
      "capital",
      "income",
      "expenses",
      "workdays",
      "payroll",
    ];
    setDownloading("all");
    setDownloadAllProgress({ done: 0, total: kinds.length });
    let failures = 0;
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      try {
        await apiDownload(
          `/api/admin/exports/${kind}.csv?start=${start}&end=${end}`,
          `${kind}-${start}_${end}.csv`,
        );
      } catch (err) {
        failures += 1;
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage(`Failed to download ${kind} CSV.`, err),
        });
      }
      setDownloadAllProgress({ done: i + 1, total: kinds.length });
    }
    setDownloading(null);
    setDownloadAllProgress(null);
    if (failures === 0) {
      publishInlineMessage({
        type: "SUCCESS",
        text: `Downloaded all ${kinds.length} CSVs.`,
      });
    } else if (failures < kinds.length) {
      publishInlineMessage({
        type: "WARNING",
        text: `Downloaded ${kinds.length - failures} of ${kinds.length} CSVs (${failures} failed).`,
      });
    }
  }

  // Dropdown items + per-type description for the download section.
  // Keep the order operator-meaningful: money first (Capital → Income
  // → Expenses), then labor (Workdays → Payroll). The description map
  // is keyed by the same `value` strings so the info box swaps as the
  // dropdown selection changes.
  const downloadKindCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: "Capital", value: "capital" },
          { label: "Income", value: "income" },
          { label: "Expenses", value: "expenses" },
          { label: "Workdays", value: "workdays" },
          { label: "Payroll", value: "payroll" },
        ],
      }),
    [],
  );
  const downloadDescriptions: Record<typeof downloadKind, { title: string; body: string }> = {
    capital: {
      title: "Capital",
      body:
        "Capital contributions (owner money in) and owner draws (owner money out). Equity entries — match against the equity accounts in your accounting software.",
    },
    income: {
      title: "Income",
      body:
        "Every inflow in the window — one row per service payment (or equipment rental), with a Workers column listing who worked the job. Payment Net is the bank-deposit figure; Worker Payouts and Owner Earnings sum to Payment Net per row.",
    },
    expenses: {
      title: "Expenses",
      body:
        "Operating business expenses (the P&L side) in the selected window. Use to validate spend categories against your accounting software.",
    },
    workdays: {
      title: "Workdays",
      body:
        "One row per worker per workday in the window: start / end times, paused minutes, active hours, and approval status. Use to reconcile against Gusto payroll hours.",
    },
    payroll: {
      title: "Payroll",
      body:
        "One row per worker shaped for Gusto: hours, hourly wage, regular wages, additional earnings, total gross, and equivalent hourly rate. Type the hours and additional earnings into Gusto for each worker.",
    },
  };
  const selectedDescription = downloadDescriptions[downloadKind];

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
      {/* Informational banner — collapsible, collapsed by default.
          When closed, just shows the headline + chevron so the page
          opens straight to the dates + report. */}
      <Box bg="blue.50" borderLeftWidth="3px" borderColor="blue.400" borderRadius="md">
        <HStack
          as="button"
          onClick={() => setInfoExpanded((v) => !v)}
          gap={2}
          p={3}
          w="full"
          textAlign="left"
          align="flex-start"
          cursor="pointer"
          _hover={{ bg: "blue.100" }}
          borderRadius="md"
        >
          <Box pt={0.5}><FiInfo /></Box>
          <Text flex="1" fontSize="sm" fontWeight="semibold" color="blue.900">
            Use this tab to double-check your books against your accounting software
          </Text>
          <Box pt={0.5} color="blue.900">
            {infoExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </Box>
        </HStack>
        {infoExpanded && (
          <VStack align="stretch" gap={2} px={3} pb={3} pl={10}>
            <Text fontSize="xs" color="blue.900">
              Your accounting software is the source of truth — it&apos;s wired straight to the bank. Use this tab to spot-check that everything lines up: pick a date range, glance at the Profit and Loss numbers next to the same report in your accounting software, and download a CSV when you want a side-by-side look at money in, money out, or owner contributions and draws. Click any line in the P&amp;L to see the rows behind it.
            </Text>
            <Text fontSize="xs" color="blue.900">
              The lower sections show what was actually worked and earned in the same date range: hours clocked, jobs completed, and what each worker took home after fees, top-ups, and the owner&apos;s cut. Workers earning below ${(period?.minWagePerHour ?? 7.25).toFixed(2)}/hr (the minimum wage from settings) are flagged so you can catch shortfalls before payroll runs.
            </Text>
            {/* Red callout — overtime is a known gap; surface it loudly
                so the operator doesn't trust the numbers blindly when
                someone has worked more than 40 hours in a week. */}
            <Box mt={1} p={2} bg="red.50" borderLeftWidth="3px" borderColor="red.500" borderRadius="sm">
              <Text fontSize="xs" color="red.900" fontWeight="semibold">
                Heads up: overtime isn&apos;t included yet
              </Text>
              <Text fontSize="xs" color="red.900">
                This tab doesn&apos;t currently calculate the 1.5× overtime premium owed when an hourly worker logs more than 40 hours in a workweek. If anyone goes into overtime, you&apos;ll need to add the premium manually in payroll until this gets wired up.
              </Text>
            </Box>
          </VStack>
        )}
      </Box>

      {/* Date range picker + presets. Intentionally non-collapsible
          — picking the date range is the entry point for every other
          section, so it's always visible. */}
      <Card.Root>
        <CardSectionHeader
          title="Select Timeframe"
          subtitle="Pick a date range or use a preset. Every section below scopes its numbers to this window."
          collapsible={false}
        />
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

      {/* Expand/Collapse all — sits between the timeframe (always
          visible) and the first collapsible section so the operator
          can open everything at once after picking a date range. */}
      <HStack justify="flex-end" gap={2}>
        <Button
          size="xs"
          variant="ghost"
          onClick={expandAllSections}
          disabled={allExpanded}
        >
          Expand all
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={collapseAllSections}
          disabled={allCollapsed}
        >
          Collapse all
        </Button>
      </HStack>

      {/* CSV downloads — flat files for accounting-software cross-checks.
          Positioned first below the dates so the operator can grab the
          CSVs without scrolling past the rendered P&L. */}
      <Card.Root>
        <CardSectionHeader
          title="Download CSV"
          subtitle="Files for cross-checking against accounting software to reconcile accounts."
          collapsed={isSectionCollapsed("download")}
          onToggle={() => toggleSection("download")}
        />
        {!isSectionCollapsed("download") && (
        <Card.Body>
          <VStack align="stretch" gap={3}>
            {/* Type picker + single Download button. Replaced the
                five-button row so the section is compact regardless of
                how many file types we add later. */}
            <HStack gap={2} wrap="wrap" align="center">
              <Select.Root
                collection={downloadKindCollection}
                value={[downloadKind]}
                onValueChange={(e) => {
                  const v = e.value[0] as typeof downloadKind | undefined;
                  if (v) setDownloadKind(v);
                }}
                size="sm"
                positioning={{ strategy: "fixed", hideWhenDetached: true }}
                css={{ width: "auto", flex: "0 0 auto" }}
              >
                <Select.Control>
                  <Select.Trigger w="auto" minW="160px" px="2" title="Select download type">
                    <Select.ValueText />
                  </Select.Trigger>
                </Select.Control>
                <Select.Positioner>
                  <Select.Content>
                    {downloadKindCollection.items.map((it) => (
                      <Select.Item key={it.value} item={it.value}>
                        <Select.ItemText>{it.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Select.Root>
              <Button
                size="sm"
                colorPalette="blue"
                onClick={() => void downloadCsv(downloadKind)}
                disabled={downloading !== null || loading}
              >
                {downloading === downloadKind ? <Spinner size="xs" /> : <FiDownload />}
                <Text ml={2}>Download</Text>
              </Button>
              {/* "Download All" — sequentially fetches every CSV type
                  for the selected date range. Disabled while either
                  the single Download or another All-batch is running.
                  Label flips to a progress count while in-flight so
                  the operator knows the batch is grinding through. */}
              <Button
                size="sm"
                colorPalette="blue"
                variant="outline"
                onClick={() => void downloadAllCsvs()}
                disabled={downloading !== null || loading}
                title="Download every CSV type for the selected date range, one after another."
              >
                {downloading === "all" ? <Spinner size="xs" /> : <FiDownload />}
                <Text ml={2}>
                  {downloading === "all" && downloadAllProgress
                    ? `Downloading ${downloadAllProgress.done}/${downloadAllProgress.total}…`
                    : "Download All"}
                </Text>
              </Button>
            </HStack>
            {/* Description box — swaps based on the selected type so
                operator sees only the relevant explanation. Styled as
                a light gray info panel to read as informational, not
                actionable. */}
            <Box
              p={3}
              bg="gray.50"
              borderLeftWidth="3px"
              borderColor="gray.300"
              borderRadius="md"
            >
              <Text fontSize="sm" fontWeight="semibold" mb={1}>
                {selectedDescription.title}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {selectedDescription.body}
              </Text>
            </Box>
          </VStack>
        </Card.Body>
        )}
      </Card.Root>

      {/* P&L Report rendering with expand/collapse. */}
      <Card.Root>
        <CardSectionHeader
          title="Profit and Loss"
          subtitle="Cash-basis P&L for the selected window. Tap any line to drill into the underlying rows."
          collapsed={isSectionCollapsed("pnl")}
          onToggle={() => toggleSection("pnl")}
        />
        {!isSectionCollapsed("pnl") && (
        <Card.Body>
          {loading && !report ? (
            <HStack justify="center" py={6}><Spinner /></HStack>
          ) : !report ? (
            <Text fontSize="sm" color="fg.muted">Pick a date range to view the report.</Text>
          ) : (
            <VStack align="stretch" gap={0}>
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

              {/* Excluded from P&L — categories the operator explicitly
                  opted out of via `plSection: EXCLUDE_FROM_PNL`.
                  Visibility only: dollars do NOT count toward Net
                  Operating Income. Surfaced so no Ledger entry can
                  silently disappear from the financial surface;
                  drill-down works the same as any other row. */}
              {(report.excluded?.flat.length > 0 || report.excluded?.groups.length > 0) && (
                <>
                  <Box mt={4} px={3} py={1.5} bg="gray.100" borderTopWidth="1px" borderColor="gray.300">
                    <Text fontSize="xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
                      Excluded from P&amp;L
                    </Text>
                    <Text fontSize="2xs" color="fg.muted">
                      Categories opted out via Settings. Not counted toward Net Operating Income — shown for visibility so every Ledger entry is accounted for somewhere.
                    </Text>
                  </Box>
                  <BucketRows bucket={report.excluded} expanded={expanded} details={details} onToggle={toggleAccount} />
                  <HStack
                    justify="space-between"
                    px={3}
                    py={1.5}
                    bg="gray.50"
                    borderTopWidth="1px"
                    borderColor="gray.200"
                  >
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted">Total Excluded</Text>
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted" fontStyle="italic">
                      {fmtUSD(report.excluded.total)}
                    </Text>
                  </HStack>
                </>
              )}
            </VStack>
          )}
        </Card.Body>
        )}
      </Card.Root>

      {/* Period summary — the trust ledger. Folded in from the old
          Workers Reconcile tab. Loads in parallel with the P&L using
          the same date range. */}
      {periodLoading && !period ? (
        <HStack justify="center" py={6}><Spinner /></HStack>
      ) : !period ? null : (
        <>
          {/* Payroll — Gusto-shaped per-worker row set. Click any
              numeric cell to copy. Hours + Additional Earnings are the
              two values the operator types into Gusto per worker;
              Regular Wages is what Gusto auto-computes from the on-file
              hourly rate. Equivalent Hourly Rate is the sanity-check
              column. */}
          <Card.Root>
            <CardSectionHeader
              title="Payroll"
              subtitle={
                <>
                  For each worker: type <b>Hours</b> and <b>Additional Earnings</b> into Gusto. Tap any number to copy.
                </>
              }
              collapsed={isSectionCollapsed("payroll")}
              onToggle={() => toggleSection("payroll")}
            />
            {!isSectionCollapsed("payroll") && (
            <Card.Body>
              {period.payroll.length === 0 ? (
                <Text fontSize="sm" color="fg.muted" textAlign="center">
                  No active workers in this window.
                </Text>
              ) : (
                <Box overflowX="auto">
                  <Table.Root size="sm" variant="line">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader fontSize="2xs">Worker</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs">Type</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Hours</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Hourly Wage</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Regular Wages</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Additional Earnings</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Total Gross</Table.ColumnHeader>
                        <Table.ColumnHeader fontSize="2xs" textAlign="right">Equivalent Hourly Rate</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {period.payroll.map((p) => {
                        const belowMin =
                          p.equivalentHourlyRate != null &&
                          p.equivalentHourlyRate > 0 &&
                          p.equivalentHourlyRate < (period.minWagePerHour ?? 7.25);
                        return (
                          <Table.Row key={p.userId}>
                            <Table.Cell fontSize="xs" fontWeight="semibold">
                              {p.displayName ?? p.email ?? "(unnamed)"}
                            </Table.Cell>
                            <Table.Cell fontSize="xs">
                              <Badge size="xs" colorPalette={workerTypePalette(p.workerType, p.isOwner)} variant="subtle">
                                {workerTypeLabel(p.workerType, p.isOwner)}
                              </Badge>
                            </Table.Cell>
                            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => void copyToClipboard(p.hours.toFixed(2))}
                                title="Click to copy"
                              >
                                {p.hours.toFixed(2)}
                              </Button>
                            </Table.Cell>
                            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => void copyToClipboard(p.hourlyWage.toFixed(2))}
                                title="Click to copy"
                              >
                                {fmtUSD(p.hourlyWage)}
                              </Button>
                            </Table.Cell>
                            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => void copyToClipboard(p.regularWages.toFixed(2))}
                                title="Click to copy"
                              >
                                {fmtUSD(p.regularWages)}
                              </Button>
                            </Table.Cell>
                            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => void copyToClipboard(p.additionalEarnings.toFixed(2))}
                                title="Click to copy"
                              >
                                {fmtUSD(p.additionalEarnings)}
                              </Button>
                            </Table.Cell>
                            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="bold">
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => void copyToClipboard(p.totalGross.toFixed(2))}
                                title="Click to copy"
                              >
                                {fmtUSD(p.totalGross)}
                              </Button>
                            </Table.Cell>
                            <Table.Cell
                              fontSize="xs"
                              textAlign="right"
                              fontFamily="mono"
                              color={belowMin ? "red.600" : "fg.default"}
                              fontWeight={belowMin ? "semibold" : undefined}
                            >
                              {p.equivalentHourlyRate == null ? "—" : `${fmtUSD(p.equivalentHourlyRate)}/hr`}
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                </Box>
              )}
            </Card.Body>
            )}
          </Card.Root>

          {/* Per-worker rows */}
          <Card.Root>
            <CardSectionHeader
              title={
                <>
                  Workers ({period.workers.length})
                  {period.totals.anomalies > 0 && (
                    <Badge ml={2} size="xs" colorPalette="yellow" variant="subtle">
                      {period.totals.anomalies} anomaly{period.totals.anomalies === 1 ? "" : "ies"}
                    </Badge>
                  )}
                </>
              }
              subtitle="Rows sorted by anomaly count (most first), then net paid. Tap a worker to see the day-by-day breakdown; tap a day to see each job's contribution."
              collapsed={isSectionCollapsed("workers")}
              onToggle={() => toggleSection("workers")}
            />
            {!isSectionCollapsed("workers") && (
            <Card.Body>
              {period.workers.length === 0 ? (
                <Text fontSize="sm" color="fg.muted" textAlign="center" py={4}>
                  No workers logged in this window.
                </Text>
              ) : (
                <VStack align="stretch" gap={1}>
                  {period.workers.map((w) => (
                    <WorkerCard
                      key={w.userId}
                      worker={w}
                      minWage={period.minWagePerHour}
                      expanded={expandedWorkers.has(w.userId)}
                      onToggle={() =>
                        setExpandedWorkers((prev) => {
                          const next = new Set(prev);
                          if (next.has(w.userId)) next.delete(w.userId);
                          else next.add(w.userId);
                          return next;
                        })
                      }
                      expandedDays={expandedWorkerDays}
                      onToggleDay={(dayKey) =>
                        setExpandedWorkerDays((prev) => {
                          const next = new Set(prev);
                          if (next.has(dayKey)) next.delete(dayKey);
                          else next.add(dayKey);
                          return next;
                        })
                      }
                    />
                  ))}
                </VStack>
              )}
            </Card.Body>
            )}
          </Card.Root>
        </>
      )}

    </VStack>
  );
}

// ── Render helpers ───────────────────────────────────────────────────────────

/**
 * Prominent header bar for a Card.Root. Used as a sibling to
 * Card.Body so the title sits in a colored band at the top of the
 * card. When `collapsible` is true, the bar is clickable and shows a
 * chevron that reflects `collapsed`; callers gate Card.Body
 * rendering on the corresponding state.
 *
 * Background palette defaults to slate; pass a different palette
 * (e.g. "indigo") for sections that already have a colored card body
 * so the header reads as a deeper tone of the same family.
 */
function CardSectionHeader({
  title,
  subtitle,
  collapsible = true,
  collapsed = false,
  onToggle,
  palette = "gray",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  palette?: string;
}) {
  // Pre-built palette table so Chakra's static class generator sees
  // each color reference at build time. Dynamic string interpolation
  // (`${palette}.200`) works at runtime but can fall through to white
  // when the variant isn't recognized.
  const palettes: Record<string, { bg: string; hoverBg: string; borderColor: string }> = {
    gray:   { bg: "gray.100",   hoverBg: "gray.200",   borderColor: "gray.200" },
    // Custom indigo tokens only define .50 / .200 / .700 / .900 in this
    // codebase. The Reconciliation Targets card body is already
    // `indigo.50`, so the header has to be a DEEPER shade (.200) to
    // visually separate from the body — otherwise the bar disappears
    // into the card.
    indigo: { bg: "indigo.200", hoverBg: "indigo.200", borderColor: "indigo.200" },
    blue:   { bg: "blue.100",   hoverBg: "blue.200",   borderColor: "blue.200" },
    green:  { bg: "green.100",  hoverBg: "green.200",  borderColor: "green.200" },
  };
  const { bg, hoverBg, borderColor } = palettes[palette] ?? palettes.gray;
  // Render as a div (not button). Browser user-agent stylesheets
  // apply their own background to <button> elements which was
  // overriding the Chakra `bg` prop and showing as white. Keep the
  // keyboard semantics via role="button" + tabIndex when clickable.
  return (
    <Box
      onClick={collapsible ? onToggle : undefined}
      role={collapsible ? "button" : undefined}
      tabIndex={collapsible ? 0 : undefined}
      onKeyDown={collapsible
        ? (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle?.();
            }
          }
        : undefined}
      w="full"
      textAlign="left"
      bg={bg}
      borderTopRadius="md"
      borderBottomWidth="1px"
      borderColor={borderColor}
      px={4}
      py={2.5}
      cursor={collapsible ? "pointer" : "default"}
      _hover={collapsible ? { bg: hoverBg } : undefined}
    >
      <HStack justify="space-between" align="center" w="full">
        <VStack align="start" gap={0} flex="1" minW={0}>
          <Text fontSize="md" fontWeight="bold">{title}</Text>
          {subtitle && (
            <Text fontSize="xs" color="fg.muted">{subtitle}</Text>
          )}
        </VStack>
        {collapsible && (
          <Box flexShrink={0} color="fg.muted">
            {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          </Box>
        )}
      </HStack>
    </Box>
  );
}

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

// ── Worker-side sub-components (folded in from ReconcileWorkersTab) ─────────

function WorkerCard({
  worker,
  minWage,
  expanded,
  onToggle,
  expandedDays,
  onToggleDay,
}: {
  worker: WorkerRow;
  minWage: number;
  expanded: boolean;
  onToggle: () => void;
  expandedDays: Set<string>;
  onToggleDay: (dayKey: string) => void;
}) {
  void minWage;
  return (
    <Box
      borderWidth="1px"
      borderColor={worker.anomalies.length > 0 ? "yellow.300" : "gray.200"}
      borderRadius="md"
      bg={worker.anomalies.length > 0 ? "yellow.50" : undefined}
    >
      <HStack
        as="button"
        onClick={onToggle}
        gap={2}
        p={2.5}
        w="full"
        textAlign="left"
        align="center"
        _hover={{ bg: "blackAlpha.50" }}
        cursor="pointer"
        wrap="wrap"
      >
        <Box flexShrink={0} color="fg.muted">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </Box>
        <VStack align="start" gap={0} flex="1" minW="180px">
          <HStack gap={2} wrap="wrap">
            <Text fontSize="sm" fontWeight="semibold">
              {worker.displayName ?? worker.email ?? "(unnamed)"}
            </Text>
            <Badge size="xs" colorPalette={workerTypePalette(worker.workerType, worker.isOwner)} variant="subtle">
              {workerTypeLabel(worker.workerType, worker.isOwner)}
            </Badge>
            {worker.hasInProgressWorkday && (
              <Badge size="xs" colorPalette="green" variant="solid">
                On the clock
              </Badge>
            )}
            {worker.belowMinWage && (
              <Badge size="xs" colorPalette="red" variant="solid">
                Below min wage
              </Badge>
            )}
            {worker.anomalies.length > 0 && !worker.belowMinWage && (
              <Badge size="xs" colorPalette="yellow" variant="solid">
                ⚠ {worker.anomalies.length}
              </Badge>
            )}
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            {worker.hoursActive.toFixed(2)}h{worker.hasInProgressWorkday && " (live)"} · {worker.daysWorked} day{worker.daysWorked === 1 ? "" : "s"}
            · {worker.jobsCompleted} job{worker.jobsCompleted === 1 ? "" : "s"}
            {worker.ownerEarnings > 0 && ` · owner cut ${fmtUSD(worker.ownerEarnings)}`}
          </Text>
        </VStack>
        <VStack align="end" gap={0} flexShrink={0}>
          <Text fontSize="sm" fontWeight="bold">{fmtUSD(worker.netPaid)}</Text>
          {worker.effectiveHourly != null && (
            <Text
              fontSize="xs"
              color={worker.belowMinWage ? "red.600" : "fg.muted"}
              fontWeight={worker.belowMinWage ? "semibold" : undefined}
            >
              {fmtUSD(worker.effectiveHourly)}/hr
              {worker.preTopUpHourly != null &&
                worker.preTopUpHourly !== worker.effectiveHourly &&
                ` · pre-top-up ${fmtUSD(worker.preTopUpHourly)}/hr`}
            </Text>
          )}
        </VStack>
      </HStack>

      {expanded && (
        <Box px={3} pb={3} pt={1} borderTopWidth="1px" borderColor="gray.200">
          {worker.anomalies.length > 0 && (
            <Box mb={2} p={2} bg="yellow.100" borderRadius="md">
              <HStack gap={2} align="flex-start">
                <Box pt={0.5}><AlertTriangle size={14} color="var(--chakra-colors-yellow-800)" /></Box>
                <VStack align="start" gap={0}>
                  {worker.anomalies.map((a, i) => (
                    <Text key={i} fontSize="xs" color="yellow.900">
                      • {a}
                    </Text>
                  ))}
                </VStack>
              </HStack>
            </Box>
          )}

          {/* Earnings breakdown summary */}
          <HStack gap={4} mb={3} wrap="wrap">
            <BreakdownStat label="Gross" value={fmtUSD(worker.grossEarnings)} />
            <BreakdownStat label="Fee/margin" value={fmtUSD(-worker.feesOrMargin)} />
            <BreakdownStat label="Top-ups" value={fmtUSD(worker.topUps)} />
            <BreakdownStat label="Net paid" value={fmtUSD(worker.netPaid)} bold />
          </HStack>

          {/* Day-by-day breakdown */}
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
            Daily breakdown
          </Text>
          {worker.days.length === 0 ? (
            <Text fontSize="xs" color="fg.muted" fontStyle="italic">No activity recorded.</Text>
          ) : (
            <VStack align="stretch" gap={1}>
              {worker.days.map((d) => {
                const dayKey = `${worker.userId}|${d.date}`;
                const dayExpanded = expandedDays.has(dayKey);
                return (
                  <Box
                    key={d.date}
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="md"
                    bg="white"
                  >
                    <HStack
                      as="button"
                      onClick={() => onToggleDay(dayKey)}
                      gap={2}
                      px={2.5}
                      py={1.5}
                      w="full"
                      textAlign="left"
                      align="center"
                      _hover={{ bg: "blackAlpha.50" }}
                      cursor="pointer"
                      wrap="wrap"
                    >
                      <Box flexShrink={0} color="fg.muted">
                        {dayExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </Box>
                      <Text fontSize="xs" fontFamily="mono" minW="90px">{d.date}</Text>
                      {d.inProgress && (
                        <Badge size="xs" colorPalette="green" variant="subtle">in progress</Badge>
                      )}
                      <Text fontSize="xs" color="fg.muted" flex="1" minW="80px">
                        {d.hoursActive.toFixed(2)}h{d.inProgress && " (live)"} · {d.jobsCompleted} job{d.jobsCompleted === 1 ? "" : "s"}
                      </Text>
                      <Text fontSize="xs" fontWeight="semibold">{fmtUSD(d.netPaid)}</Text>
                    </HStack>
                    {dayExpanded && d.jobs.length > 0 && (
                      <Box px={2.5} pb={2} pt={0.5} borderTopWidth="1px" borderColor="gray.100">
                        <Table.Root size="sm" variant="line">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeader fontSize="2xs">Job</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Gross</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Fee/margin</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Top-up</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Net</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs">Status</Table.ColumnHeader>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {d.jobs.map((j) => (
                              <Table.Row key={j.occurrenceId}>
                                <Table.Cell fontSize="xs">
                                  <Text>{j.title}</Text>
                                  {j.client && (
                                    <Text fontSize="2xs" color="fg.muted">{j.client}</Text>
                                  )}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                  {fmtUSD(j.grossShare)}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                  {fmtUSD(-j.feeOrMargin)}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                  {j.topUp > 0 ? fmtUSD(j.topUp) : "—"}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="semibold">
                                  {fmtUSD(j.netPaid)}
                                </Table.Cell>
                                <Table.Cell fontSize="2xs">
                                  {j.paymentWrittenOff ? (
                                    <Badge size="xs" colorPalette="gray" variant="subtle">written off</Badge>
                                  ) : j.paymentConfirmed ? (
                                    <Badge size="xs" colorPalette="green" variant="subtle">paid</Badge>
                                  ) : (
                                    <Badge size="xs" colorPalette="yellow" variant="subtle">unpaid</Badge>
                                  )}
                                  {j.source === "computed" && (
                                    <Badge ml={1} size="xs" colorPalette="orange" variant="outline">computed</Badge>
                                  )}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Root>
                      </Box>
                    )}
                  </Box>
                );
              })}
            </VStack>
          )}
        </Box>
      )}
    </Box>
  );
}

function BreakdownStat({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <Box>
      <Text fontSize="2xs" color="fg.muted">{label}</Text>
      <Text fontSize="sm" fontWeight={bold ? "bold" : undefined} fontFamily="mono">{value}</Text>
    </Box>
  );
}
