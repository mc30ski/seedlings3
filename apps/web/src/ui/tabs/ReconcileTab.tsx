"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Box, Button, Card, Checkbox, HStack, Select, Spinner, Table, Text, VStack, createListCollection } from "@chakra-ui/react";
import { FiDownload, FiInfo, FiUpload } from "react-icons/fi";
import { ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { apiGet, apiDownload, apiGetText } from "@/src/lib/api";
import { usePersistedState } from "@/src/lib/usePersistedState";
import DateInput from "@/src/ui/components/DateInput";
import PayrollUploadDialog from "@/src/ui/dialogs/PayrollUploadDialog";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import { bizToday, bizAddDays, bizMondayOnOrBefore, bizStartOfMonth, bizStartOfYear, type EtDateKey } from "@/src/lib/dates";

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

type PnLRow = {
  qbAccount: string;
  total: number;
  /** Present when contributing categories had taxDeductiblePercent < 100.
   *  Drives the inline parent + (deductible) + (non-deductible) split
   *  rendering plus the Estimated Taxable Operating Income totals. */
  taxBreakdown?: {
    deductiblePct: number;
    deductibleAmount: number;
    nonDeductibleAmount: number;
  };
};
type PnLExpenseGroup = {
  parent: string;
  directTotal: number;
  children: PnLRow[];
  subtotal: number;
};
type PnLBucket = { groups: PnLExpenseGroup[]; flat: PnLRow[]; total: number };
type EmployerPayrollTaxComponent = {
  key: string;
  label: string;
  ratePct: number;
  amount: number;
};

type PnLMode = "accrual" | "cash";

type PnLReport = {
  range: { from: string; to: string };
  /** Which wage-anchor mode the server built this report with. See
   *  services/pnlReport.ts for the full explanation — short version:
   *  "accrual" (default) anchors wages on Payment.confirmedAt for the
   *  matching principle; "cash" anchors on completedAt to match the
   *  workdays CSV (the Gusto source of truth). */
  mode: PnLMode;
  income: { rows: PnLRow[]; total: number };
  cogs: PnLBucket;
  grossProfit: number;
  expenses: PnLBucket;
  netOperatingIncome: number;
  /** Sum of non-deductible dollars across COGS + Expense rows. */
  totalNonDeductibleExpenses: number;
  /** NOI + totalNonDeductibleExpenses — the tax-effective version of
   *  Net Operating Income. */
  estimatedTaxableOperatingIncome: number;
  /** Categories explicitly opted out of the P&L. Visibility-only —
   *  the dollars here do NOT roll into expenses or netOperatingIncome.
   *  Surfaced in a dedicated section at the bottom so the operator can
   *  confirm every Ledger entry is accounted for somewhere. */
  excluded: PnLBucket;
  /** Per-component breakdown for the synthetic "Employer payroll taxes
   *  (est.)" line — drives the expandable detail without another
   *  roundtrip. Undefined when there are no W-2 wages in the period. */
  employerPayrollTaxes?: {
    wages: number;
    components: EmployerPayrollTaxComponent[];
    total: number;
    totalRatePct: number;
  };
  /** Sum of fixed-asset-eligible BusinessExpense rows in the window.
   *  These dollars are capitalized to the balance sheet, land in the
   *  Excluded bucket under "Fixed Assets (capitalized)", and are
   *  subtracted from NOI to yield operatingCashAfterCapEx. */
  fixedAssetPurchases: number;
  /** NOI − fixedAssetPurchases. Cash reality after equipment CapEx —
   *  what the operator "actually kept" this period, ignoring the
   *  GAAP capitalization/depreciation timing. */
  operatingCashAfterCapEx: number;
};

type PnLDetailRow = {
  date: string;
  primary: string;
  secondary?: string;
  amount: number;
  // Wages-drill extras — surfaced under the row so it's obvious HOW
  // the money was paid out (split%) and BOTH date anchors (when the
  // work was done vs when the payment came in) side-by-side.
  splitPercent?: number;
  serviceDate?: string;
  paymentDate?: string;
  /** JobOccurrence.id for occurrence-linked drill rows. When set the
   *  row becomes a clickable link that jumps to the job in the Jobs
   *  tab with the occurrence highlighted. */
  occurrenceId?: string;
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
type WorkerJobAssigneeBreakdown = {
  userId: string;
  displayName: string | null;
  workerType: string | null;
  isOwner: boolean;
  splitPercent: number;
  gross: number;
  feeOrMargin: number;
  topUp: number;
  netPaid: number;
  /** True for the synthetic owner-earnings row — the LLC owner's cut
   *  off the top, not a worker split. */
  isOwnerEarnings: boolean;
};

type WorkerJobRow = {
  occurrenceId: string;
  title: string;
  client: string | null;
  property: string | null;
  completedAt: string | null;
  /** The full job's promised payout — anchors the per-assignee math
   *  in the drill-down. */
  jobPrice: number;
  grossShare: number;
  feeOrMargin: number;
  topUp: number;
  netPaid: number;
  /** What % of the job payment this worker was credited for.
   *  0 for owner-earnings pseudo-rows (owner takes off the top, not
   *  via a split). */
  splitPercent: number;
  paymentConfirmed: boolean;
  paymentWrittenOff: boolean;
  source: "snapshot" | "computed";
  /** Full per-assignee breakdown for the drill-down. */
  assignees: WorkerJobAssigneeBreakdown[];
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
  /** Payment-anchored, unlike everything else on this row — a tip belongs
   *  to the period the client paid, not the period the work happened. */
  tips: number;
  additionalEarnings: number;
  totalGross: number;
  equivalentHourlyRate: number | null;
};

/** Client-side mirror of services/reconcileWorkers.ts payrollTypeLabel.
 *  Keep in sync so the preview matches the downloaded CSV verbatim. */
function payrollTypeLabelClient(t: string | null | undefined, isOwner: boolean): string {
  if (isOwner) return "Owner";
  switch (t) {
    case "EMPLOYEE": return "Employee";
    case "TRAINEE": return "Trainee";
    case "CONTRACTOR": return "Contractor";
    default: return "Unclassified";
  }
}

type PayrollPreviewRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
  isOwner: boolean;
  hours: number;
  hourlyWage: number;
  regularWages: number;
  /** Payment-anchored, unlike everything else on this row — a tip belongs
   *  to the period the client paid, not the period the work happened. */
  tips: number;
  additionalEarnings: number;
  totalGross: number;
  equivalentHourlyRate: number | null;
};

/** Mirrors the server-side owner-reassignment reshape in payrollCsv(). Kept
 *  in sync so the preview totals match the downloaded CSV byte-for-byte
 *  when the operator has flagged rows via the "Assign to Owner" toggle.
 *  Per-column sum — every numeric column on the owner row is the owner's
 *  own value plus the same column across all flagged rows. Regular + Add =
 *  Total Gross stays true because the identity holds for each source row
 *  and sums linearly. Hourly Wage is intentionally NOT summed (it's an
 *  on-file rate, not a period aggregate). Rounding uses the same round2
 *  semantics as reconcileWorkers.ts. */
function applyAssignToOwner(
  rows: PayrollPreviewRow[],
  assignSet: Set<string>,
): PayrollPreviewRow[] {
  if (assignSet.size === 0) return rows;
  const owner = rows.find((r) => r.isOwner);
  if (!owner) return rows;
  const out = rows.map((r) => ({ ...r }));
  const ownerOut = out.find((r) => r.userId === owner.userId)!;
  let addHours = 0;
  let addRegular = 0;
  let addAdditional = 0;
  let addTips = 0;
  let addTotal = 0;
  for (const r of out) {
    if (r.userId === ownerOut.userId) continue;
    if (!assignSet.has(r.userId)) continue;
    addHours += r.hours;
    addRegular += r.regularWages;
    addAdditional += r.additionalEarnings;
    addTips += r.tips;
    addTotal += r.totalGross;
    r.hours = 0;
    r.regularWages = 0;
    r.additionalEarnings = 0;
    r.tips = 0;
    r.totalGross = 0;
    r.equivalentHourlyRate = null;
  }
  ownerOut.hours = Math.round((ownerOut.hours + addHours) * 100) / 100;
  ownerOut.regularWages = Math.round((ownerOut.regularWages + addRegular) * 100) / 100;
  ownerOut.additionalEarnings =
    Math.round((ownerOut.additionalEarnings + addAdditional) * 100) / 100;
  ownerOut.tips = Math.round((ownerOut.tips + addTips) * 100) / 100;
  ownerOut.totalGross = Math.round((ownerOut.totalGross + addTotal) * 100) / 100;
  ownerOut.equivalentHourlyRate =
    ownerOut.hours > 0
      ? Math.round((ownerOut.totalGross / ownerOut.hours) * 100) / 100
      : null;
  return out;
}

/** Payroll preview — same column order + formatting as the CSV, plus
 *  a leading checkbox column that controls the export subset. Totals
 *  row at the bottom reflects only the checked rows so the operator
 *  sees the running total for what they're about to download.
 *
 *  Trailing "Assign to Owner" column is a UI-only reshape: checking a
 *  row transfers that worker's hours + totals to the ownerʼs row and
 *  zeros the worker's own row. Backend data is untouched — the
 *  download endpoint receives the flagged ids and mirrors the same
 *  transform in the CSV. */
function PayrollPreviewTable(props: {
  rows: PayrollPreviewRow[];
  selectedIds: string[];
  onToggle: (userId: string) => void;
  onToggleAll: (checked: boolean) => void;
  assignToOwnerIds: string[];
  onToggleAssign: (userId: string) => void;
}) {
  const {
    rows,
    selectedIds,
    onToggle,
    onToggleAll,
    assignToOwnerIds,
    onToggleAssign,
  } = props;
  const selectedSet = new Set(selectedIds);
  const assignSet = new Set(assignToOwnerIds);
  const owner = rows.find((r) => r.isOwner) ?? null;
  const reshapedRows = applyAssignToOwner(rows, assignSet);
  const allChecked = rows.length > 0 && selectedIds.length === rows.length;
  const noneChecked = selectedIds.length === 0;
  const totalHours = reshapedRows.reduce(
    (s, r) => s + (selectedSet.has(r.userId) ? r.hours : 0),
    0,
  );
  const totalGross = reshapedRows.reduce(
    (s, r) => s + (selectedSet.has(r.userId) ? r.totalGross : 0),
    0,
  );
  return (
    <Box
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      overflow="hidden"
    >
      <HStack
        px={3}
        py={2}
        bg="gray.100"
        borderBottomWidth="1px"
        borderColor="gray.200"
        justify="space-between"
      >
        <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
          Preview
        </Text>
        <Text fontSize="xs" color={noneChecked ? "orange.700" : "fg.muted"}>
          {noneChecked
            ? "No workers selected — export will be empty"
            : allChecked
              ? `All ${rows.length} workers`
              : `${selectedIds.length} of ${rows.length} selected`}
        </Text>
      </HStack>
      <Box maxH="360px" overflow="auto">
        {rows.length === 0 ? (
          <Box p={3}>
            <Text fontSize="xs" color="fg.muted" fontStyle="italic">
              No workers in the selected range.
            </Text>
          </Box>
        ) : (
          <Table.Root size="sm" variant="line" striped>
            <Table.Header position="sticky" top={0} bg="white" zIndex={1}>
              <Table.Row>
                <Table.ColumnHeader w="1" px={2}>
                  <Checkbox.Root
                    checked={allChecked ? true : noneChecked ? false : "indeterminate"}
                    onCheckedChange={(e) => onToggleAll(!!e.checked)}
                    size="sm"
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                  </Checkbox.Root>
                </Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap">Worker</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap">Type</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap">Email</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap" textAlign="right">Hours</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap" textAlign="right">Hourly Wage</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap" textAlign="right">Regular Wages</Table.ColumnHeader>
                <Table.ColumnHeader
                  fontSize="2xs"
                  whiteSpace="nowrap"
                  textAlign="right"
                  title="Client tips earned in this period. Anchored on the date the CLIENT PAID, not the date of the job — so a tip can land on a later payroll than the job it came from. Enter in Gusto's Tips earning type, not Additional Earnings."
                >
                  Tips
                </Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap" textAlign="right">Additional Earnings</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap" textAlign="right">Total Gross</Table.ColumnHeader>
                <Table.ColumnHeader fontSize="2xs" whiteSpace="nowrap" textAlign="right">$/hr</Table.ColumnHeader>
                <Table.ColumnHeader
                  fontSize="2xs"
                  whiteSpace="nowrap"
                  textAlign="center"
                  title="Move this worker's hours + pay to the Owner row for the export. UI-only — data isn't changed."
                >
                  → Owner
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {reshapedRows.map((r) => {
                const checked = selectedSet.has(r.userId);
                const assigned = assignSet.has(r.userId);
                const canAssign = !!owner && !r.isOwner;
                return (
                  <Table.Row key={r.userId} opacity={checked ? 1 : 0.4}>
                    <Table.Cell px={2}>
                      <Checkbox.Root
                        checked={checked}
                        onCheckedChange={() => onToggle(r.userId)}
                        size="sm"
                      >
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                      </Checkbox.Root>
                    </Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap">
                      {r.displayName ?? "(unnamed)"}
                    </Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap">
                      {payrollTypeLabelClient(r.workerType, r.isOwner)}
                    </Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap">{r.email ?? ""}</Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{r.hours.toFixed(2)}</Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{r.hourlyWage.toFixed(2)}</Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{r.regularWages.toFixed(2)}</Table.Cell>
                    <Table.Cell
                      fontSize="xs"
                      whiteSpace="nowrap"
                      textAlign="right"
                      color={r.tips > 0 ? "green.700" : undefined}
                      fontWeight={r.tips > 0 ? "semibold" : undefined}
                    >
                      {r.tips.toFixed(2)}
                    </Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{r.additionalEarnings.toFixed(2)}</Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{r.totalGross.toFixed(2)}</Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">
                      {r.equivalentHourlyRate == null ? "" : r.equivalentHourlyRate.toFixed(2)}
                    </Table.Cell>
                    <Table.Cell textAlign="center" px={2}>
                      {canAssign ? (
                        <Checkbox.Root
                          checked={assigned}
                          onCheckedChange={() => onToggleAssign(r.userId)}
                          size="sm"
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                        </Checkbox.Root>
                      ) : (
                        <Text fontSize="2xs" color="fg.muted">—</Text>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
              <Table.Row bg="gray.50" fontWeight="semibold">
                <Table.Cell px={2}></Table.Cell>
                <Table.Cell fontSize="xs">TOTALS</Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
                <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{totalHours.toFixed(2)}</Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
                <Table.Cell fontSize="xs" whiteSpace="nowrap" textAlign="right">{totalGross.toFixed(2)}</Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
                <Table.Cell fontSize="xs"></Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table.Root>
        )}
      </Box>
    </Box>
  );
}

/** Minimal RFC-4180-ish CSV parser — handles quoted cells (which the
 *  server uses for values containing commas, quotes, or newlines).
 *  Doubled quotes inside a quoted cell become a literal quote. Returns
 *  a rows-of-cells matrix; empty trailing rows are dropped so the
 *  preview count matches what the operator would count by eye. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote?
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch === "\r") { /* skip — handled with the \n */ }
      else cell += ch;
    }
  }
  // Flush final cell / row if the input didn't end with a newline.
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  // Drop trailing empty rows (blank lines at EOF).
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

function fmtUSD(n: number): string {
  // Accounting / P&L convention: negatives render as `($30.45)`
  // rather than `−$30.45`. Easier to spot at a glance in a column of
  // figures and matches how QuickBooks displays the same numbers.
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${formatted})` : `$${formatted}`;
}

// Render a split percentage compactly: whole numbers drop the ".00"
// (so "50%" not "50.00%"), non-whole show up to 2 decimals ("33.33%").
function fmtPercent(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function leafName(qbAccount: string, mode?: PnLMode): string {
  const colon = qbAccount.indexOf(":");
  const raw = colon < 0 ? qbAccount : qbAccount.slice(colon + 1).trim();
  // Mode-aware relabel for the Wages account. Server keeps the account
  // key stable as "Wages (accrued)" (used for drilldown lookups + QB
  // account mapping), but the "(accrued)" wording is misleading when
  // the operator has switched to cash mode — cash mode anchors the row
  // on JobOccurrence.completedAt (work-in-window) rather than
  // Payment.confirmedAt (payment-in-window). Swap the display label
  // when we know the current mode.
  if (mode === "cash" && raw === "Wages (accrued)") return "Wages (paid)";
  return raw;
}

// Short badge label for a specific anomaly string. Backend produces
// full-sentence anomalies (e.g. "3 jobs completed but client payment
// not confirmed"); the row header needs terse chips instead. Falls
// back to "Warning" for anything the pattern list doesn't recognize
// so a new backend anomaly type never renders as a blank badge.
function shortAnomalyLabel(anomaly: string): string {
  if (anomaly.includes("Logged hours but no completed jobs")) return "No jobs";
  if (anomaly.includes("Completed jobs but no workday hours")) return "No hours";
  if (anomaly.includes("reclassification risk")) return "Low rate";
  if (anomaly.includes("below minimum wage")) return "Below min wage";
  if (anomaly.includes("client payment not confirmed")) {
    // Preserve the count when present ("3 jobs completed but client
    // payment not confirmed" → "3 unpaid").
    const m = anomaly.match(/^(\d+)\s+jobs?/);
    return m ? `${m[1]} unpaid` : "Unpaid";
  }
  return "Warning";
}

// Wage-floor violation — ONLY W-2 employees / trainees below floor
// with actual completed work. Minimum-wage law doesn't apply to
// independent contractors, so their low rates are a soft warning
// (see getRowWarnings below), not a red violation. The jobsCompleted
// > 0 gate suppresses the spurious "$0/hr because 0 jobs closed"
// case where the flag would fire on a worker who's just clocked in
// but hasn't finished anything yet.
function hasWageViolation(w: WorkerRow, minWage: number): boolean {
  if (w.isOwner) return false;
  if (w.preTopUpHourly == null || w.preTopUpHourly >= minWage) return false;
  if (w.jobsCompleted === 0) return false;
  return w.workerType === "EMPLOYEE" || w.workerType === "TRAINEE";
}

// Row-level warnings — the single source of truth for the orange
// "Warning" badges and the yellow banner in the expanded body.
// Combines backend anomalies (with the below-floor one dropped when
// it's already surfaced as a red violation) with client-synthesized
// warnings that the backend doesn't produce — currently just the
// contractor-low-rate reclassification signal.
function getRowWarnings(w: WorkerRow, minWage: number): string[] {
  const out: string[] = [];
  const violation = hasWageViolation(w, minWage);
  for (const a of w.anomalies) {
    if (violation && a.includes("below minimum wage")) continue;
    out.push(a);
  }
  // Contractor-below-floor is a reclassification-risk signal (the
  // DOL/IRS cite persistently low effective rates when reclassifying
  // 1099s to W-2). Same jobsCompleted > 0 gate so a contractor who
  // just clocked in doesn't spuriously flag at $0/hr.
  if (
    !w.isOwner &&
    w.workerType === "CONTRACTOR" &&
    w.jobsCompleted > 0 &&
    w.preTopUpHourly != null &&
    w.preTopUpHourly < minWage
  ) {
    out.push(
      `Effective rate $${w.preTopUpHourly.toFixed(2)}/hr below $${minWage.toFixed(2)}/hr — reclassification risk`,
    );
  }
  return out;
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
  // Shortcut so the routine "payroll just ran, import it" case doesn't
  // require navigating to Super → Money → Payroll. Same dialog, same
  // Super-only endpoint. See docs/features/payroll.md.
  //
  // NOTE: this does NOT connect payroll to anything on this tab. The P&L's
  // "Employer payroll taxes (est.)" line stays an estimate — see the
  // estimate/actual firewall in the spec, enforced by payroll-build-gate.
  const [payrollUploadOpen, setPayrollUploadOpen] = useState(false);
  const thisMondayDefault = bizMondayOnOrBefore();
  const [start, setStart] = useState(thisMondayDefault);
  const [end, setEnd] = useState(bizAddDays(thisMondayDefault, 6));
  const [report, setReport] = useState<PnLReport | null>(null);
  const [loading, setLoading] = useState(false);
  // Wage-anchor mode for the P&L. Default accrual — matches every
  // historical view of this tab. Persisted so an operator who prefers
  // cash-basis reconciliation doesn't have to re-toggle every visit.
  // Every fetch to /pnl-report and /pnl-report/details includes this
  // as a query param so the server-side computation stays consistent
  // with the drill-down rows.
  const [pnlMode, setPnlMode] = usePersistedState<PnLMode>("reconcile_pnlMode", "accrual");
  // Period (worker-side) state — fetched in parallel with the P&L
  // from the same date range. Drives the Period Summary,
  // Reconciliation Targets, and per-worker drill-downs at the bottom
  // of the page (folded in from the old Workers Reconcile tab).
  const [period, setPeriod] = useState<Period | null>(null);
  const [periodLoading, setPeriodLoading] = useState(false);
  // Per-worker expand state for the worker drill-downs. Three levels:
  // worker → day → job. Job-level opens a per-assignee breakdown of a
  // single occurrence ("who made what on this job").
  const [expandedWorkers, setExpandedWorkers] = useState<Set<string>>(new Set());
  const [expandedWorkerDays, setExpandedWorkerDays] = useState<Set<string>>(new Set());
  const [expandedWorkerJobs, setExpandedWorkerJobs] = useState<Set<string>>(new Set());
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
  // Starts unset — operator opts into a preview + download by
  // picking a type. Keeps the section quiet on tab-open (no auto
  // network fetch) and matches "when nothing is selected, don't
  // show a preview".
  const [downloadKind, setDownloadKind] = useState<
    "capital" | "income" | "expenses" | "workdays" | "payroll" | null
  >(null);
  // Preview state — rows parsed from the CSV. First row = header.
  // Bounded to PREVIEW_MAX_ROWS entries to keep the rendered table
  // cheap regardless of underlying file size.
  const [previewRows, setPreviewRows] = useState<string[][] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewTotalRows, setPreviewTotalRows] = useState(0);
  // Payroll-only worker narrowing. Explicit selection semantic:
  //   • `null`   — picker hasn't been initialized yet (no period
  //     data OR non-payroll type). Frontend omits the query param
  //     → backend returns all workers (backward compat).
  //   • `[]`     — operator unchecked everyone. Frontend sends
  //     `?userIds=` → backend returns 0 rows.
  //   • `[...]`  — selected subset.
  // Initialized to ALL worker IDs whenever payroll is picked (so
  // the default UI state is "everyone checked"). Reset when the
  // type changes away or the date range shifts (workers available
  // may differ for a new period).
  const [payrollUserIds, setPayrollUserIds] = useState<string[] | null>(null);
  // UI-only export-shape: userIds flagged here have their hours and pay
  // transferred to the owner row for the downloaded CSV. Backend data is
  // never changed — the server mirrors the same reshape via the
  // `assignToOwner=` query param on the payroll endpoint.
  const [payrollAssignToOwnerIds, setPayrollAssignToOwnerIds] = useState<string[]>([]);
  useEffect(() => {
    setPayrollUserIds(null);
    setPayrollAssignToOwnerIds([]);
  }, [downloadKind, start, end]);
  useEffect(() => {
    if (downloadKind !== "payroll") return;
    if (!period) return;
    if (payrollUserIds !== null) return;
    // Seed from period.payroll (which now includes zero-row entries for
    // every approved worker + owner). Every row starts checked; operator
    // can uncheck anyone they don't need in the export.
    setPayrollUserIds(period.payroll.map((p) => p.userId));
  }, [downloadKind, period, payrollUserIds]);
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
    () => ["download", "pnl", "workers"] as const,
    [],
  );
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SECTION_KEYS.map((k) => [k, true])),
  );
  const toggleSection = (key: string) =>
    setSectionCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const isSectionCollapsed = (key: string) => !!sectionCollapsed[key];

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
    const pnlPromise = apiGet<PnLReport>(`/api/admin/business-expenses/pnl-report?from=${start}&to=${end}&mode=${pnlMode}`)
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
  }, [start, end, pnlMode]);

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
    setExpandedWorkerJobs(new Set());
  }, [start, end]);

  // Mode change → clear ONLY the P&L + its drilldown cache (wages /
  // employer-tax details would otherwise disagree with the freshly-
  // reloaded main report). Period/worker sections are wage-anchor-
  // agnostic; leaving them intact avoids a needless reload flicker.
  useEffect(() => {
    setReport(null);
    setExpanded(new Set());
    setDetails({});
  }, [pnlMode]);

  // Inline CSV preview — refetches when the export type or the date
  // range changes so the operator always sees the current window's
  // data. Stale-guard via a cancelled flag prevents a slow response
  // for a previous type/range from overwriting a newer one. Truncates
  // to a bounded number of rows so a 10K-row workday CSV doesn't
  // choke the DOM.
  //
  // Skips entirely when no type is selected (`downloadKind` null) —
  // the section shows a "pick a type" hint instead of an empty table.
  const PREVIEW_MAX_ROWS = 20;
  useEffect(() => {
    // Payroll uses its own inline table (built from period.payroll +
    // the checkbox selection) so we skip the CSV fetch entirely for
    // that kind — the CSV would just be re-rendered from data the
    // client already has.
    if (!downloadKind || downloadKind === "payroll" || !start || !end) {
      setPreviewRows(null);
      setPreviewError(null);
      setPreviewTruncated(false);
      setPreviewTotalRows(0);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    (async () => {
      try {
        // Payroll is short-circuited above (uses its own inline table
        // fed from period.payroll), so downloadKind here is one of
        // the CSV-preview kinds — no userIds param applies to any
        // of them.
        const text = await apiGetText(
          `/api/admin/exports/${downloadKind}.csv?start=${start}&end=${end}`,
        );
        if (cancelled) return;
        const parsed = parseCsv(text);
        // First row is the header; data rows are the rest. Only the
        // data rows count toward the "N rows" summary + truncation.
        const header = parsed[0] ?? [];
        const dataRows = parsed.slice(1);
        setPreviewTotalRows(dataRows.length);
        setPreviewTruncated(dataRows.length > PREVIEW_MAX_ROWS);
        setPreviewRows([header, ...dataRows.slice(0, PREVIEW_MAX_ROWS)]);
      } catch (err: any) {
        if (cancelled) return;
        setPreviewError(err?.message ?? "Failed to load preview.");
        setPreviewRows(null);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [downloadKind, start, end, payrollUserIds]);

  async function toggleAccount(qbAccount: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(qbAccount)) {
        next.delete(qbAccount);
        return next;
      }
      next.add(qbAccount);
      // Employer Payroll Taxes detail is already on the report payload
      // (per-component breakdown computed server-side at build time).
      // Synthesize the same shape the details endpoint returns instead
      // of a roundtrip — the data is fully derivable from what the UI
      // already has.
      if (qbAccount === "Payroll:Employer payroll taxes (est.)" && report?.employerPayrollTaxes) {
        const synth: PnLDetail = {
          qbAccount,
          rows: report.employerPayrollTaxes.components.map((c) => ({
            date: "",
            primary: `${c.label} (${c.ratePct.toFixed(2)}%)`,
            secondary: `Applied to $${report!.employerPayrollTaxes!.wages.toFixed(2)} wages`,
            amount: c.amount,
          })),
          total: report.employerPayrollTaxes.total,
        };
        setDetails((d) => ({ ...d, [qbAccount]: synth }));
        return next;
      }
      const cached = details[qbAccount];
      if (!cached || (typeof cached === "object" && "error" in cached)) {
        setDetails((d) => ({ ...d, [qbAccount]: "loading" }));
        apiGet<PnLDetail>(
          `/api/admin/business-expenses/pnl-report/details?from=${start}&to=${end}&qbAccount=${encodeURIComponent(qbAccount)}&mode=${pnlMode}`,
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
      // Only the payroll export honors per-worker narrowing today —
      // the other CSVs don't have a workers dimension. Always send
      // `userIds` when the picker is initialized (even if empty) so
      // "unchecked everyone" produces an empty CSV instead of
      // silently reverting to the all-workers default. `null` means
      // the picker hasn't loaded yet → omit the param entirely.
      // `assignToOwner` is a UI-only export-shape flag list — server
      // mirrors the preview reshape when it's non-empty. Omitting it
      // when empty keeps CSVs from earlier "Download All" calls
      // untouched by this feature.
      let qs = "";
      if (kind === "payroll" && payrollUserIds !== null) {
        qs += `&userIds=${encodeURIComponent(payrollUserIds.join(","))}`;
      }
      if (kind === "payroll" && payrollAssignToOwnerIds.length > 0) {
        qs += `&assignToOwner=${encodeURIComponent(payrollAssignToOwnerIds.join(","))}`;
      }
      await apiDownload(
        `/api/admin/exports/${kind}.csv?start=${start}&end=${end}${qs}`,
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
        // Same payroll-only shaping the single-CSV path applies:
        // narrow to selected workers and mirror the owner-reassign
        // transform. Every other CSV kind gets no extra qs.
        let batchQs = "";
        if (kind === "payroll" && payrollUserIds !== null) {
          batchQs += `&userIds=${encodeURIComponent(payrollUserIds.join(","))}`;
        }
        if (kind === "payroll" && payrollAssignToOwnerIds.length > 0) {
          batchQs += `&assignToOwner=${encodeURIComponent(payrollAssignToOwnerIds.join(","))}`;
        }
        await apiDownload(
          `/api/admin/exports/${kind}.csv?start=${start}&end=${end}${batchQs}`,
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
  const downloadDescriptions: Record<Exclude<typeof downloadKind, null>, { title: string; body: string }> = {
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
  // Null-safe — nothing selected means no description panel renders.
  const selectedDescription = downloadKind ? downloadDescriptions[downloadKind] : null;

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
          const endStr = bizAddDays(nextMonthStart as EtDateKey, -1);
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
  // Net Operating Margin — the "what % of revenue ends up as operating
  // profit" badge alongside Net Operating Income. For service
  // businesses this is the genuinely meaningful margin since Gross
  // Profit % is artificially high when labor sits in Expenses (per QB
  // convention) rather than COGS.
  const netOperatingPct = report && report.income.total > 0
    ? Math.round((report.netOperatingIncome / report.income.total) * 1000) / 10
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

      {/* Date range picker + presets. Always visible — picking the
          date range is the entry point for every other section. No
          Card / SectionHeader wrapper so it doesn't visually mimic
          the collapsible P&L / Payroll cards below. */}
      <Box>
        <VStack align="stretch" gap={3}>
          {/* Timeframe row — DateInput + dash + DateInput + green preset
              chip on a single line, matching the PaymentsTab layout. */}
          <HStack gap={2} wrap="wrap" align="center">
              {/* Payroll import shortcut. Deliberately at the TOP LEVEL, not
                  inside one of the collapsible cards — every section below
                  is collapsed by default, so a shortcut buried in one is not
                  a shortcut. It also does not belong in "Export Data": this
                  is an import, and the direction matters to the operator.
                  Ends the row so it never crowds the dates on a phone.
                  Opens the same dialog as Money → Payroll. */}
              <DateInput
                value={start}
                onChange={(val) => {
                  setSelectedPreset(null);
                  setStart(val as EtDateKey);
                  if (end && val && val > end) setEnd(val as EtDateKey);
                }}
              />
              <Text fontSize="sm">–</Text>
              <DateInput
                value={end}
                min={start || undefined}
                onChange={(val) => {
                  setSelectedPreset(null);
                  setEnd(val as EtDateKey);
                  if (start && val && val < start) setStart(val as EtDateKey);
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
                          setStart(r.from as EtDateKey);
                          setEnd(r.to);
                        }}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </VStack>
                )}
              </Box>
              <Button
                size="sm"
                colorPalette="green"
                variant="outline"
                flexShrink={0}
                onClick={() => setPayrollUploadOpen(true)}
                title="Import the latest Gusto payroll journal (also on Money → Payroll)."
              >
                <FiUpload />
                <Text ml={2}>Upload payroll</Text>
              </Button>
            </HStack>
            {/* By-category chip strip — same look as the Ledger tab. Sits
                directly under the timeframe so the operator sees the spend
              breakdown at a glance before scrolling into the P&L table. */}
          {report && <ExpenseCategoryChips report={report} />}
        </VStack>
      </Box>

      {/* P&L Report rendering with expand/collapse. */}
      <Card.Root>
        <CardSectionHeader
          title={
            <>
              Profit and Loss
              {/* Profit/loss chip — mirrors the Net Operating Income
                  color at the bottom of the P&L so the operator can
                  tell the range's outcome at a glance even when the
                  section is collapsed. */}
              {report && (
                <Badge
                  ml={2}
                  size="xs"
                  colorPalette={report.netOperatingIncome >= 0 ? "green" : "red"}
                  variant="solid"
                >
                  {report.netOperatingIncome >= 0 ? "Profitable" : "Loss"}
                </Badge>
              )}
            </>
          }
          subtitle="P&L for the selected window. Tap any line to drill into the underlying rows."
          collapsed={isSectionCollapsed("pnl")}
          onToggle={() => toggleSection("pnl")}
        />
        {!isSectionCollapsed("pnl") && (
        <Card.Body>
          {/* Wage-anchor mode toggle — Accrual (default) vs Cash basis.
              Only the wage + employer-tax lines actually differ; every
              other row (income, expenses, fixed assets) is anchored
              the same way regardless of mode. The blue info panel
              below explains what the current mode is doing. */}
          <PnlModeToggle mode={pnlMode} onChange={setPnlMode} />
          <PnlModeInfo mode={pnlMode} />
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
                  <BucketRows bucket={report.cogs} expanded={expanded} details={details} onToggle={toggleAccount} mode={pnlMode} />
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
                  <BucketRows bucket={report.expenses} expanded={expanded} details={details} onToggle={toggleAccount} mode={pnlMode} />
                  <TotalRow label="Total Expenses" amount={report.expenses.total} />
                </>
              )}

              {/* Net Operating Income (GAAP — fixed-asset purchases
                  capitalized to balance sheet, not included). */}
              <HStack
                justify="space-between"
                px={3}
                py={2.5}
                bg={report.netOperatingIncome < 0 ? "red.50" : "green.50"}
                borderTopWidth="2px"
                borderColor="gray.300"
                mt={2}
              >
                <HStack gap={2} align="baseline">
                  <Text fontSize="md" fontWeight="bold">Net Operating Income (GAAP)</Text>
                  {netOperatingPct !== null && (
                    <Text fontSize="xs" color="fg.muted">({netOperatingPct}%)</Text>
                  )}
                </HStack>
                <Text
                  fontSize="md"
                  fontWeight="bold"
                  color={report.netOperatingIncome < 0 ? "red.600" : "green.700"}
                >
                  {fmtUSD(report.netOperatingIncome)}
                </Text>
              </HStack>
              {/* Cash-adjusted subtotal — deduction line for fixed-asset
                  purchases + the resulting cash reality after
                  equipment CapEx. Rendered UNCONDITIONALLY (even when
                  the CapEx figure is $0) so the P&L layout is stable
                  across periods — an operator scanning back through
                  months shouldn't see the bottom rows shift between
                  reports. A zero CapEx period just shows "−$0.00" and
                  the cash-after line equals NOI. Your CPA decides §179
                  vs multi-year depreciation at tax time; this shows
                  the cash-out number without waiting for that
                  decision. */}
              <HStack
                justify="space-between"
                px={3}
                py={1.5}
                bg="orange.50"
                borderTopWidth="1px"
                borderColor="gray.200"
              >
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" fontWeight="semibold" color="orange.900">
                    Less: Fixed asset purchases
                  </Text>
                  <Text fontSize="2xs" color="orange.800" fontStyle="italic">
                    Capitalized to balance sheet — click Excluded below for the row detail
                  </Text>
                </VStack>
                <Text fontSize="sm" fontWeight="semibold" color="orange.900">
                  −{fmtUSD(report.fixedAssetPurchases)}
                </Text>
              </HStack>
              {/* Deeper shade than the NOI row above — signals this is
                  the final bottom-line cash figure for the period,
                  distinct from the GAAP NOI it derives from. */}
              <HStack
                justify="space-between"
                px={3}
                py={2.5}
                bg={report.operatingCashAfterCapEx < 0 ? "red.100" : "green.100"}
                borderTopWidth="2px"
                borderColor="gray.300"
              >
                <Text fontSize="md" fontWeight="bold">Operating Cash After CapEx</Text>
                <Text
                  fontSize="md"
                  fontWeight="bold"
                  color={report.operatingCashAfterCapEx < 0 ? "red.700" : "green.800"}
                >
                  {fmtUSD(report.operatingCashAfterCapEx)}
                </Text>
              </HStack>
              {/* Estimated taxable operating income — adds back the
                  non-deductible portion of expenses (Meals 50%, etc.)
                  that NOI already subtracted. Only surfaced when there
                  IS a non-deductible portion to add back; otherwise
                  it'd just duplicate the NOI row. Italic + muted to
                  signal "derived informational metric," not a primary
                  P&L line. */}
              {report.totalNonDeductibleExpenses > 0.005 && (
                <HStack
                  justify="space-between"
                  px={3}
                  py={1.5}
                  bg="blue.50"
                  borderTopWidth="1px"
                  borderColor="gray.200"
                >
                  <VStack align="start" gap={0}>
                    <Text fontSize="sm" fontWeight="semibold" color="blue.900">
                      Estimated taxable operating income
                    </Text>
                    <Text fontSize="2xs" color="blue.800" fontStyle="italic">
                      NOI + {fmtUSD(report.totalNonDeductibleExpenses)} non-deductible expense
                      {report.totalNonDeductibleExpenses === 1 ? "" : "s"}
                    </Text>
                  </VStack>
                  <Text
                    fontSize="sm"
                    fontWeight="semibold"
                    color={report.estimatedTaxableOperatingIncome < 0 ? "red.700" : "blue.900"}
                  >
                    {fmtUSD(report.estimatedTaxableOperatingIncome)}
                  </Text>
                </HStack>
              )}
              {/* Accrual-divergence footnote — only shown when synthetic
                  Wages or Employer Payroll Taxes are actually deducted in
                  the period. Tells the operator upfront why this number
                  won't tie to QB exactly (Gusto timing), so they can
                  trust it for decisions without trying to reconcile. */}
              {report.employerPayrollTaxes && (
                <Box px={3} py={2} mt={1}>
                  <Text fontSize="2xs" color="fg.muted" lineHeight="1.4">
                    Wages and Employer Payroll Taxes are accrued — counted in the period the payment was confirmed, not when Gusto cuts the check. This makes Net Operating Income show whether the work billed this period was profitable. QuickBooks reports them in the period Gusto actually disburses, so this NOI typically leads QB&apos;s by a few days. Employer tax rates are configurable in Super → Settings → PAYROLL_TAX_ESTIMATES (default {report.employerPayrollTaxes.totalRatePct.toFixed(2)}% of wages).
                  </Text>
                </Box>
              )}

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
                  <BucketRows bucket={report.excluded} expanded={expanded} details={details} onToggle={toggleAccount} mode={pnlMode} />
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
          {/* Combined Workers & Payroll — one row per worker.
              Collapsed: name, badges, hours, net paid, effective rate.
              Expanded: the Gusto-copy payroll fields (Hours / Hourly
              Wage / Regular Wages / Tips / Additional Earnings / Total Gross /
              Equivalent Hourly Rate — tap to copy) sit on top of the
              earnings breakdown, then the day-by-day and per-job
              drill-down. Everything the operator needs to run payroll
              AND reconcile it lives in one place. */}

          <Card.Root>
            <CardSectionHeader
              title={
                <>
                  Worker Payroll ({period.workers.length})
                  {/* Badge order matches the per-row header: highest
                      severity first (red violation), then warning
                      (orange). Reads consistently at both levels so
                      the operator's eye lands on the strongest signal
                      in the same spot regardless of scope. */}
                  {(() => {
                    const count = period.workers.filter((w) =>
                      hasWageViolation(w, period.minWagePerHour),
                    ).length;
                    return count > 0 ? (
                      <Badge ml={2} size="xs" colorPalette="red" variant="solid">
                        {count} {count === 1 ? "violation" : "violations"}
                      </Badge>
                    ) : null;
                  })()}
                  {(() => {
                    // Sum derived warnings across all workers so the
                    // header count matches the sum of per-row badges
                    // (including client-synthesized contractor low
                    // rates).
                    const count = period.workers.reduce(
                      (s, w) => s + getRowWarnings(w, period.minWagePerHour).length,
                      0,
                    );
                    return count > 0 ? (
                      <Badge ml={2} size="xs" colorPalette="orange" variant="solid">
                        {count} {count === 1 ? "warning" : "warnings"}
                      </Badge>
                    ) : null;
                  })()}
                </>
              }
              subtitle="Every worker shows their Gusto-copy payroll fields inline — tap any number to copy. Expand a worker to see the day-by-day breakdown and each job's contribution."
              collapsed={isSectionCollapsed("workers")}
              onToggle={() => toggleSection("workers")}
            />
            {!isSectionCollapsed("workers") && (
            <Card.Body>
              {/* Wage-compliance banner — surfaces workers whose
                  effective rate in the window sits below the configured
                  floor. W-2 below-floor is a legal compliance issue;
                  contractors below-floor is a "reclassification risk"
                  signal — the persistent pattern the DOL/IRS cite when
                  reclassifying 1099s. Renders
                  inside the payroll card so the flagged rows sit
                  directly under it. */}
              <WageComplianceBanner
                workers={period.workers}
                minWagePerHour={period.minWagePerHour}
              />
              {period.workers.length === 0 ? (
                <Text fontSize="sm" color="fg.muted" textAlign="center" py={4}>
                  No workers logged in this window.
                </Text>
              ) : (
                <VStack align="stretch" gap={1}>
                  {period.workers.map((w) => {
                    const payroll = period.payroll.find((p) => p.userId === w.userId) ?? null;
                    return (
                      <WorkerCard
                        key={w.userId}
                        worker={w}
                        payroll={payroll}
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
                        expandedJobs={expandedWorkerJobs}
                        onToggleJob={(jobKey) =>
                          setExpandedWorkerJobs((prev) => {
                            const next = new Set(prev);
                            if (next.has(jobKey)) next.delete(jobKey);
                            else next.add(jobKey);
                            return next;
                          })
                        }
                      />
                    );
                  })}
                </VStack>
              )}
            </Card.Body>
            )}
          </Card.Root>
        </>
      )}

      {/* CSV downloads — last section so the rendered Reconcile data
          (P&L + Payroll + Workers) reads first. Always rendered
          regardless of period-load state so the operator can pull
          CSVs even before the period payload finishes. */}
      <Card.Root>
        <CardSectionHeader
          title="Export Data"
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
                value={downloadKind ? [downloadKind] : []}
                onValueChange={(e) => {
                  const v = e.value[0] as Exclude<typeof downloadKind, null> | undefined;
                  setDownloadKind(v ?? null);
                }}
                size="sm"
                positioning={{ strategy: "fixed", hideWhenDetached: true }}
                css={{ width: "auto", flex: "0 0 auto" }}
              >
                <Select.Control>
                  <Select.Trigger w="auto" minW="180px" px="2" title="Select download type">
                    <Select.ValueText placeholder="Select a type…" />
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
                onClick={() => downloadKind && void downloadCsv(downloadKind)}
                disabled={!downloadKind || downloading !== null || loading}
              >
                {downloadKind && downloading === downloadKind ? <Spinner size="xs" /> : <FiDownload />}
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
            {selectedDescription && (
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
            )}
            {/* Preview — only renders once the operator has picked a
                type. Two variants:
                  • payroll → inline table built from period.payroll
                    with a checkbox as the first column (default all
                    checked). Totals reflect the checked subset. Same
                    checkbox state feeds the download.
                  • everything else → CSV fetch + parsed generic table. */}
            {downloadKind === "payroll" && period && payrollUserIds !== null ? (
              <PayrollPreviewTable
                rows={period.payroll}
                selectedIds={payrollUserIds}
                onToggle={(userId) => {
                  setPayrollUserIds((prev) => {
                    if (prev === null) return prev;
                    return prev.includes(userId)
                      ? prev.filter((id) => id !== userId)
                      : [...prev, userId];
                  });
                }}
                onToggleAll={(checked) => {
                  setPayrollUserIds(checked ? period.payroll.map((r) => r.userId) : []);
                }}
                assignToOwnerIds={payrollAssignToOwnerIds}
                onToggleAssign={(userId) => {
                  setPayrollAssignToOwnerIds((prev) =>
                    prev.includes(userId)
                      ? prev.filter((id) => id !== userId)
                      : [...prev, userId],
                  );
                }}
              />
            ) : downloadKind && downloadKind !== "payroll" ? (
              <Box
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                overflow="hidden"
              >
                <HStack
                  px={3}
                  py={2}
                  bg="gray.100"
                  borderBottomWidth="1px"
                  borderColor="gray.200"
                  justify="space-between"
                >
                  <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                    Preview
                  </Text>
                  {previewLoading && <Spinner size="xs" />}
                  {!previewLoading && !previewError && previewRows && previewRows.length > 1 && (
                    <Text fontSize="xs" color="fg.muted">
                      {previewTruncated
                        ? `Showing first ${PREVIEW_MAX_ROWS} of ${previewTotalRows} rows`
                        : `${previewTotalRows} row${previewTotalRows === 1 ? "" : "s"}`}
                    </Text>
                  )}
                </HStack>
                <Box maxH="360px" overflow="auto">
                  {previewError ? (
                    <Box p={3}>
                      <Text fontSize="xs" color="red.600">{previewError}</Text>
                    </Box>
                  ) : !previewRows || previewRows.length <= 1 ? (
                    <Box p={3}>
                      <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                        {previewLoading ? "Loading…" : "No data for the selected range."}
                      </Text>
                    </Box>
                  ) : (
                    <Table.Root size="sm" variant="line" striped>
                      <Table.Header position="sticky" top={0} bg="white" zIndex={1}>
                        <Table.Row>
                          {previewRows[0].map((h, i) => (
                            <Table.ColumnHeader key={i} fontSize="2xs" whiteSpace="nowrap">
                              {h}
                            </Table.ColumnHeader>
                          ))}
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {previewRows.slice(1).map((r, ri) => (
                          <Table.Row key={ri}>
                            {r.map((cell, ci) => (
                              <Table.Cell key={ci} fontSize="xs" whiteSpace="nowrap">
                                {cell}
                              </Table.Cell>
                            ))}
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  )}
                </Box>
              </Box>
            ) : null}
          </VStack>
        </Card.Body>
        )}
      </Card.Root>

      <PayrollUploadDialog
        open={payrollUploadOpen}
        onClose={() => setPayrollUploadOpen(false)}
        onImported={() => {
          /* Nothing on this tab depends on payroll — the P&L numbers are
             unchanged by an import, by design. The dialog reports what it
             did and the operator closes it. */
        }}
      />
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

/**
 * Two-segment toggle for the wage-anchor mode. Rendered at the top of
 * the P&L section. Persisted state lives on the parent so a mode
 * change re-fetches the P&L payload with the matching ?mode= query.
 */
function PnlModeToggle({
  mode,
  onChange,
}: {
  mode: PnLMode;
  onChange: (m: PnLMode) => void;
}) {
  return (
    <HStack
      gap={0}
      mb={3}
      borderWidth="1px"
      borderColor="gray.300"
      borderRadius="md"
      overflow="hidden"
      display="inline-flex"
      alignSelf="flex-start"
    >
      {(["accrual", "cash"] as const).map((m) => {
        const active = mode === m;
        return (
          <Button
            key={m}
            size="xs"
            variant="ghost"
            onClick={() => onChange(m)}
            borderRadius="0"
            bg={active ? "blue.500" : "transparent"}
            color={active ? "white" : "gray.700"}
            _hover={{ bg: active ? "blue.600" : "gray.100" }}
            fontWeight={active ? "semibold" : "normal"}
            px={4}
          >
            {m === "accrual" ? "Accrual" : "Cash basis"}
          </Button>
        );
      })}
    </HStack>
  );
}

/**
 * Blue informational panel describing the CURRENT wage-anchor mode.
 * Explains what "accrual" vs "cash" changes on the P&L so the operator
 * can spot-check their numbers against the workdays CSV / Gusto entry
 * without wondering why the wage line shifts between modes.
 */
function PnlModeInfo({ mode }: { mode: PnLMode }) {
  return (
    <Box
      mb={4}
      p={3}
      bg="blue.50"
      borderWidth="1px"
      borderColor="blue.200"
      borderRadius="md"
    >
      <HStack gap={2} align="start">
        <Box color="blue.600" mt={0.5} flexShrink={0}>
          <FiInfo size={14} />
        </Box>
        <VStack align="start" gap={1}>
          <Text fontSize="xs" fontWeight="semibold" color="blue.900">
            {mode === "accrual" ? "Accrual mode (default)" : "Cash-basis mode"}
          </Text>
          <Text fontSize="xs" color="blue.900">
            {mode === "accrual"
              ? "Wages and employer payroll taxes are counted in the week the client's payment lands — matched to the money that came in. Net Operating Income tells you whether the work you got paid for this week actually made money. When a client pays late, the wages for that job show up here, not in the week you actually paid your workers."
              : "Wages and employer payroll taxes are counted in the week the work was done — the same week you paid your workers on the regular payroll cycle. Use this view to cross-check the wages column against what you keyed into payroll for this period."}
          </Text>
          <Text fontSize="2xs" color="blue.700" opacity={0.85}>
            Only the wages and employer-tax lines change between the two views. Income, other expenses, and equipment purchases stay the same.
          </Text>
        </VStack>
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
  mode,
}: {
  bucket: PnLBucket;
  expanded: Set<string>;
  details: Record<string, DetailState>;
  onToggle: (qbAccount: string) => void;
  /** Current P&L mode — used by leafName to relabel mode-sensitive
   *  account names (e.g. Wages "accrued" vs "paid"). */
  mode: PnLMode;
}) {
  return (
    <>
      {mergeBucketEntries(bucket).map((entry) =>
        entry.kind === "flat" ? (
          <ExpandableRow
            key={`flat:${entry.row.qbAccount}`}
            label={leafName(entry.row.qbAccount, mode)}
            amount={entry.row.total}
            indent={1}
            expanded={expanded.has(entry.row.qbAccount)}
            onToggle={() => onToggle(entry.row.qbAccount)}
            detailState={details[entry.row.qbAccount]}
            taxBreakdown={entry.row.taxBreakdown}
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
                label={leafName(c.qbAccount, mode)}
                amount={c.total}
                indent={2}
                expanded={expanded.has(c.qbAccount)}
                onToggle={() => onToggle(c.qbAccount)}
                detailState={details[c.qbAccount]}
                taxBreakdown={c.taxBreakdown}
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
  taxBreakdown,
}: {
  label: string;
  amount: number;
  indent: 1 | 2;
  bold?: boolean;
  expanded: boolean;
  onToggle: () => void;
  detailState: DetailState | undefined;
  /** When present, render two indented sub-rows below the main row
   *  showing the deductible / non-deductible split, plus a footnote.
   *  Surfaces partial deductibility (e.g. Meals 50%) at-a-glance
   *  without changing the underlying row total (cash-truth + QB
   *  reconciliation preserved). */
  taxBreakdown?: PnLRow["taxBreakdown"];
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
      {taxBreakdown && (
        <Box pl={pl + 4} pr={3} pb={1.5} pt={0.5}>
          <HStack justify="space-between" py={0.5}>
            <Text fontSize="xs" color="fg.muted">
              {label} ({taxBreakdown.deductiblePct}% deductible)
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {fmtUSD(taxBreakdown.deductibleAmount)}
            </Text>
          </HStack>
          <HStack justify="space-between" py={0.5}>
            <Text fontSize="xs" color="fg.muted">
              {label} (non-deductible)
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {fmtUSD(taxBreakdown.nonDeductibleAmount)}
            </Text>
          </HStack>
          <Text fontSize="2xs" color="fg.muted" fontStyle="italic" mt={0.5}>
            {taxBreakdown.deductiblePct}% deductible —{" "}
            {fmtUSD(taxBreakdown.deductibleAmount)} reduces taxable income.
          </Text>
        </Box>
      )}
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
      {state.rows.map((r, i) => {
        // Wages rows carry serviceDate + paymentDate + splitPercent
        // extras. Render them as a subtle metadata line so the row
        // shows: worker · property (top), then service/payment/split
        // (metadata) — makes it obvious HOW money was paid and when
        // the work vs. the payment happened. Non-wage drills stay
        // compact (no metadata line).
        const hasWageMeta =
          r.serviceDate != null || r.paymentDate != null || r.splitPercent != null;
        const metaParts: string[] = [];
        if (r.splitPercent != null) metaParts.push(`Split: ${r.splitPercent}%`);
        if (r.serviceDate) metaParts.push(`Service: ${r.serviceDate}`);
        if (r.paymentDate && r.paymentDate !== r.serviceDate) {
          metaParts.push(`Paid: ${r.paymentDate}`);
        }
        // Clickable when the row has an occurrenceId — jumps to the
        // Admin Jobs tab with that occurrence highlighted, same event
        // the Payments tab uses for its "Job" link. Falls back to a
        // plain HStack for non-linkable rows.
        const clickable = !!r.occurrenceId;
        const rowContent = (
          <>
            <HStack gap={2} flex="1" minW={0} align="start">
              {r.date && (
                <Text color="fg.muted" fontFamily="mono" flexShrink={0} minW="78px">
                  {r.date}
                </Text>
              )}
              <VStack align="start" gap={0} flex="1" minW={0}>
                <Text>{r.primary}</Text>
                {/* Link styling lives on `secondary` (client · property)
                    when the row is clickable — the target is the JOB,
                    not the worker. Underlining the worker's name read
                    as "click the worker" which isn't the action. */}
                {r.secondary && (
                  <Text
                    fontSize="2xs"
                    color={clickable ? "blue.600" : "fg.muted"}
                    textDecoration={clickable ? "underline" : undefined}
                  >
                    {r.secondary}
                  </Text>
                )}
                {hasWageMeta && metaParts.length > 0 && (
                  <Text color="fg.muted" fontSize="2xs">{metaParts.join(" · ")}</Text>
                )}
              </VStack>
            </HStack>
            <Text fontWeight="medium" flexShrink={0}>
              {fmtUSD(r.amount)}
            </Text>
          </>
        );
        return clickable ? (
          <HStack
            key={i}
            as="button"
            w="full"
            justify="space-between"
            gap={2}
            py={0.5}
            borderBottomWidth="1px"
            borderColor="gray.100"
            cursor="pointer"
            _hover={{ bg: "gray.50" }}
            textAlign="left"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("open:paymentsTabToJobsTabSearch", {
                  detail: {
                    forAdmin: true,
                    entityId: r.occurrenceId,
                    anchorAt: r.serviceDate ?? null,
                  },
                }),
              );
            }}
            title="Open the job for this wage row"
          >
            {rowContent}
          </HStack>
        ) : (
          <HStack
            key={i}
            justify="space-between"
            gap={2}
            py={0.5}
            borderBottomWidth="1px"
            borderColor="gray.100"
          >
            {rowContent}
          </HStack>
        );
      })}
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
    <Box pl={3}>
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
  payroll,
  minWage,
  expanded,
  onToggle,
  expandedDays,
  onToggleDay,
  expandedJobs,
  onToggleJob,
}: {
  worker: WorkerRow;
  payroll: PayrollRow | null;
  minWage: number;
  expanded: boolean;
  onToggle: () => void;
  expandedDays: Set<string>;
  onToggleDay: (dayKey: string) => void;
  expandedJobs: Set<string>;
  onToggleJob: (jobKey: string) => void;
}) {
  const payrollBelowMin =
    payroll?.equivalentHourlyRate != null &&
    payroll.equivalentHourlyRate > 0 &&
    payroll.equivalentHourlyRate < minWage;
  // Neutral outer border — severity is conveyed entirely by the
  // Below-min-wage / Warning badges in the row header, not the card
  // frame. Keeps the layout calm and consistent regardless of state.
  return (
    <Box
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
    >
      {/* Header + payroll strip — one visual block. Whole row is a
          click target that toggles expansion, but the individual
          PayrollStat buttons stop propagation so a copy-tap doesn't
          also toggle expand. Uses role="button" (not `as="button"`)
          so nested copy buttons stay valid HTML. */}
      <Box
        as="div"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        px={2.5}
        py={2}
        w="full"
        textAlign="left"
        _hover={{ bg: "blackAlpha.50" }}
        cursor="pointer"
      >
        <HStack gap={2} align="center" wrap="wrap">
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
              {hasWageViolation(worker, minWage) && (
                <Badge size="xs" colorPalette="red" variant="solid">
                  Below min wage
                </Badge>
              )}
              {getRowWarnings(worker, minWage).map((a, i) => (
                // One badge per specific warning, so each reason
                // reads like the red "Below min wage" chip. Same
                // shortAnomalyLabel mapping trims full-sentence text;
                // tooltip preserves the full reason.
                <Badge
                  key={i}
                  size="xs"
                  colorPalette="orange"
                  variant="solid"
                  title={a}
                >
                  {shortAnomalyLabel(a)}
                </Badge>
              ))}
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              {worker.daysWorked} day{worker.daysWorked === 1 ? "" : "s"}
              · {worker.jobsCompleted} job{worker.jobsCompleted === 1 ? "" : "s"}
              {worker.hasInProgressWorkday && " · live"}
              {worker.ownerEarnings > 0 && ` · owner cut ${fmtUSD(worker.ownerEarnings)}`}
            </Text>
          </VStack>
          <VStack align="end" gap={0} flexShrink={0}>
            <Text fontSize="sm" fontWeight="bold">{fmtUSD(worker.netPaid)}</Text>
            <Text fontSize="2xs" color="fg.muted">net paid</Text>
          </VStack>
        </HStack>

        {/* Payroll — the Gusto-copy fields, inlined right below the
            summary so scanning down the list shows every worker's
            payroll at a glance. Hours + Additional Earnings are the
            two values typed into Gusto (plus Tips, which goes in Gusto's
            own Tips earning type — never rolled into Additional Earnings);
            Regular Wages is what Gusto
            auto-computes from the on-file hourly rate. Equivalent
            Hourly Rate is the sanity-check. Every value is a copy
            button; taps stop propagation so they don't toggle expand. */}
        {payroll && (
          <HStack
            gap={3}
            mt={1.5}
            pl={5}
            wrap="wrap"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <PayrollStat
              label="Hours"
              display={payroll.hours.toFixed(2)}
              copyValue={payroll.hours.toFixed(2)}
              width="70px"
            />
            <PayrollStat
              label="Hourly Wage"
              display={fmtUSD(payroll.hourlyWage)}
              copyValue={payroll.hourlyWage.toFixed(2)}
              width="90px"
            />
            <PayrollStat
              label="Regular Wages"
              display={fmtUSD(payroll.regularWages)}
              copyValue={payroll.regularWages.toFixed(2)}
              width="110px"
            />
            {payroll.tips > 0 && (
              <PayrollStat
                label="Tips"
                display={fmtUSD(payroll.tips)}
                copyValue={payroll.tips.toFixed(2)}
                width="80px"
              />
            )}
            <PayrollStat
              label="Additional Earnings"
              display={fmtUSD(payroll.additionalEarnings)}
              copyValue={payroll.additionalEarnings.toFixed(2)}
              width="130px"
            />
            <PayrollStat
              label="Total Gross"
              display={fmtUSD(payroll.totalGross)}
              copyValue={payroll.totalGross.toFixed(2)}
              bold
              width="100px"
            />
            <PayrollStat
              label="Equivalent Hourly Rate"
              display={payroll.equivalentHourlyRate == null ? "—" : `${fmtUSD(payroll.equivalentHourlyRate)}/hr`}
              copyValue={payroll.equivalentHourlyRate == null ? "" : payroll.equivalentHourlyRate.toFixed(2)}
              bold={payrollBelowMin}
              width="120px"
              color={payrollBelowMin ? "red.600" : undefined}
            />
          </HStack>
        )}
      </Box>

      {expanded && (
        // Expanded body — subtly tinted background so the operator can
        // see at a glance which nested content belongs to which worker.
        // Anomaly cards keep the yellow family (yellow.50 outer →
        // yellow.100 inner); clean cards go plain gray. Day rows inside
        // set their own bg="white" so they still "float" above this.
        <Box
          px={3}
          pb={3}
          pt={2}
          borderTopWidth="1px"
          borderColor="gray.300"
          // Neutral grey progression for every drilldown level
          // regardless of severity. Issue signal lives on the outer
          // card's border color; the drilldown itself stays calm so
          // the numbers read easily. L1 body is gray.100.
          bg="gray.100"
          borderBottomRadius="md"
        >
          {hasWageViolation(worker, minWage) && (
            // Violation banner — red so it clearly reads as "this row
            // is a legal/compliance issue" separate from the softer
            // orange warnings. W-2 below-floor is a legal violation;
            // contractor below-floor is a reclassification-risk signal.
            // Sits above
            // the warnings banner so the highest-severity item is
            // visible first.
            <Box
              mb={2}
              p={2}
              bg="red.100"
              borderWidth="1px"
              borderColor="red.400"
              borderRadius="md"
            >
              <HStack gap={2} align="flex-start">
                <Box pt={0.5}><AlertTriangle size={14} color="var(--chakra-colors-red-700)" /></Box>
                <VStack align="start" gap={0}>
                  <Text fontSize="xs" color="red.900" fontWeight="semibold">
                    Effective rate {worker.preTopUpHourly != null ? `$${worker.preTopUpHourly.toFixed(2)}` : "—"}/hr below the ${minWage.toFixed(2)}/hr floor
                    {worker.workerType === "CONTRACTOR" && " (reclassification risk)"}
                  </Text>
                </VStack>
              </HStack>
            </Box>
          )}
          {(() => {
            // Same source as the row header — backend anomalies plus
            // client-synthesized ones (contractor low rate), with the
            // below-floor entry dropped when a red violation banner
            // already covers it.
            const displayAnomalies = getRowWarnings(worker, minWage);
            return displayAnomalies.length > 0 ? (
              // Warning banner — distinct orange so it stands out clearly
              // against the yellow anomaly-family card. Same palette as
              // the section-header "X warnings" badge for consistency.
              <Box
                mb={2}
                p={2}
                bg="orange.100"
                borderWidth="1px"
                borderColor="orange.400"
                borderRadius="md"
              >
                <HStack gap={2} align="flex-start">
                  <Box pt={0.5}><AlertTriangle size={14} color="var(--chakra-colors-orange-700)" /></Box>
                  <VStack align="start" gap={0}>
                    {displayAnomalies.map((a, i) => (
                      <Text key={i} fontSize="xs" color="orange.900" fontWeight="medium">
                        • {a}
                      </Text>
                    ))}
                  </VStack>
                </HStack>
              </Box>
            ) : null;
          })()}

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
                    borderColor="blackAlpha.200"
                    borderRadius="md"
                    // Grey progression only — issue signal lives on the
                    // outer worker-card border. L1 body is gray.100;
                    // collapsed day is a small step darker, expanded
                    // day another step. Hex values are ~5-7% brightness
                    // deltas so the level differences read subtly.
                    bg={dayExpanded ? "#e0e0e2" : "#ececed"}
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
                      // Level-2 content — table sits directly on the
                      // day box (which is now the L2 color when
                      // expanded). Only a top border separates header
                      // from list; the darker bg IS the day box's
                      // expanded bg. The `css` override forces the
                      // Chakra Table's tr/td/th transparent so the
                      // day box's bg shows through — without it the
                      // cells default to white and the progressively-
                      // darker scheme silently breaks. `overflowX="auto"`
                      // lets the 7-column table scroll horizontally on
                      // narrow viewports instead of blowing out the
                      // worker card's width.
                      <Box
                        px={2}
                        pt={1}
                        pb={1}
                        borderTopWidth="1px"
                        borderColor="blackAlpha.200"
                        overflowX="auto"
                      >
                        <Table.Root
                          size="sm"
                          variant="line"
                          minW="max-content"
                          css={{ "& tr, & td, & th": { backgroundColor: "transparent" } }}
                        >
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeader fontSize="2xs">Job</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Share</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Gross</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Fee/margin</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Top-up</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Net</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs">Status</Table.ColumnHeader>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {d.jobs.map((j) => {
                              const jobKey = `${worker.userId}|${d.date}|${j.occurrenceId}`;
                              const jobExpanded = expandedJobs.has(jobKey);
                              return (
                                <Fragment key={jobKey}>
                                  <Table.Row
                                    onClick={() => onToggleJob(jobKey)}
                                    _hover={{ bg: "blackAlpha.50" }}
                                    cursor="pointer"
                                  >
                                    <Table.Cell fontSize="xs">
                                      <HStack gap={1} align="start">
                                        <Box pt={0.5} color="fg.muted" flexShrink={0}>
                                          {jobExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        </Box>
                                        <Box>
                                          <Text>{j.title}</Text>
                                          {j.client && (
                                            <Text fontSize="2xs" color="fg.muted">{j.client}</Text>
                                          )}
                                        </Box>
                                      </HStack>
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                      {j.splitPercent > 0 ? `${fmtPercent(j.splitPercent)}%` : "—"}
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
                                  {jobExpanded && (
                                    // Level-3 drilldown — inset from the
                                    // day-list wrapper with a still-darker
                                    // border + bg. Consistent color family
                                    // as its parents (gray or yellow), one
                                    // shade deeper per level so nesting
                                    // reads at a glance.
                                    <Table.Row>
                                      <Table.Cell colSpan={7} p={0} borderBottomWidth="0px">
                                        <Box
                                          mx={2}
                                          mb={2}
                                          borderWidth="1px"
                                          borderColor="blackAlpha.300"
                                          borderRadius="md"
                                          bg="#d4d4d8"
                                        >
                                          <JobAssigneesBreakdown job={j} />
                                        </Box>
                                      </Table.Cell>
                                    </Table.Row>
                                  )}
                                </Fragment>
                              );
                            })}
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

// Full per-assignee drill-down for a single occurrence. Shows every
// active worker + any owner-earnings recipient with their split
// percent, gross, fee/margin, top-up, and net. Anchored with the job's
// total price at the top so the operator can trace "how did this
// $100 job turn into these numbers?" line by line. Totals row at
// the bottom confirms the pieces sum to the payment shape.
function JobAssigneesBreakdown({ job }: { job: WorkerJobRow }) {
  const totals = job.assignees.reduce(
    (acc, a) => ({
      gross: acc.gross + a.gross,
      feeOrMargin: acc.feeOrMargin + a.feeOrMargin,
      topUp: acc.topUp + a.topUp,
      netPaid: acc.netPaid + a.netPaid,
      splitPercent: acc.splitPercent + (a.isOwnerEarnings ? 0 : a.splitPercent),
    }),
    { gross: 0, feeOrMargin: 0, topUp: 0, netPaid: 0, splitPercent: 0 },
  );
  return (
    // No bg here — the wrapper Box in the parent sets the L3 color.
    <Box px={3} py={2}>
      <HStack gap={4} mb={2} wrap="wrap">
        <Box>
          <Text fontSize="2xs" color="fg.muted">Job price</Text>
          <Text fontSize="sm" fontFamily="mono" fontWeight="semibold">{fmtUSD(job.jobPrice)}</Text>
        </Box>
        <Box>
          <Text fontSize="2xs" color="fg.muted">Workers on job</Text>
          <Text fontSize="sm" fontFamily="mono">
            {job.assignees.filter((a) => !a.isOwnerEarnings).length}
          </Text>
        </Box>
        {job.assignees.some((a) => a.isOwnerEarnings) && (
          <Box>
            <Text fontSize="2xs" color="fg.muted">Owner cut</Text>
            <Text fontSize="sm" fontFamily="mono">
              {fmtUSD(job.assignees.filter((a) => a.isOwnerEarnings).reduce((s, a) => s + a.netPaid, 0))}
            </Text>
          </Box>
        )}
      </HStack>
      <Box overflowX="auto">
      <Table.Root
        size="sm"
        variant="line"
        minW="max-content"
        css={{ "& tr, & td, & th": { backgroundColor: "transparent" } }}
      >
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader fontSize="2xs">Worker</Table.ColumnHeader>
            <Table.ColumnHeader fontSize="2xs" textAlign="right">Share</Table.ColumnHeader>
            <Table.ColumnHeader fontSize="2xs" textAlign="right">Gross</Table.ColumnHeader>
            <Table.ColumnHeader fontSize="2xs" textAlign="right">Fee/margin</Table.ColumnHeader>
            <Table.ColumnHeader fontSize="2xs" textAlign="right">Top-up</Table.ColumnHeader>
            <Table.ColumnHeader fontSize="2xs" textAlign="right">Net</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {job.assignees.map((a, i) => (
            <Table.Row key={`${a.userId}-${a.isOwnerEarnings ? "owner" : "wage"}-${i}`}>
              <Table.Cell fontSize="xs">
                <HStack gap={1} wrap="wrap">
                  <Text fontWeight="semibold">
                    {a.displayName ?? "(unnamed)"}
                  </Text>
                  <Badge size="xs" colorPalette={workerTypePalette(a.workerType, a.isOwner)} variant="subtle">
                    {workerTypeLabel(a.workerType, a.isOwner)}
                  </Badge>
                  {a.isOwnerEarnings && (
                    <Badge size="xs" colorPalette="orange" variant="subtle">owner cut</Badge>
                  )}
                </HStack>
              </Table.Cell>
              <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                {a.isOwnerEarnings ? "—" : `${fmtPercent(a.splitPercent)}%`}
              </Table.Cell>
              <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                {fmtUSD(a.gross)}
              </Table.Cell>
              <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                {a.feeOrMargin === 0 ? "—" : fmtUSD(-a.feeOrMargin)}
              </Table.Cell>
              <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                {a.topUp > 0 ? fmtUSD(a.topUp) : "—"}
              </Table.Cell>
              <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="semibold">
                {fmtUSD(a.netPaid)}
              </Table.Cell>
            </Table.Row>
          ))}
          <Table.Row bg="blackAlpha.50">
            <Table.Cell fontSize="xs" fontWeight="bold">Total</Table.Cell>
            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="bold">
              {fmtPercent(totals.splitPercent)}%
            </Table.Cell>
            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="bold">
              {fmtUSD(totals.gross)}
            </Table.Cell>
            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="bold">
              {totals.feeOrMargin === 0 ? "—" : fmtUSD(-totals.feeOrMargin)}
            </Table.Cell>
            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="bold">
              {totals.topUp > 0 ? fmtUSD(totals.topUp) : "—"}
            </Table.Cell>
            <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="bold">
              {fmtUSD(totals.netPaid)}
            </Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table.Root>
      </Box>
    </Box>
  );
}

// Wage-compliance banner. Splits below-floor workers into three
// Only true legal-compliance violations — W-2 employees and trainees
// whose effective rate falls below the floor. Contractor low rates
// are surfaced as per-row orange "Low rate" warnings (via
// getRowWarnings) with a reclassification-risk tooltip; they're not
// legal violations so they don't warrant a top-of-body red banner.
// Uses hasWageViolation as the single source of truth so the banner
// count matches the section-header "N violations" chip and the
// per-row "Below min wage" badges.
function WageComplianceBanner({
  workers,
  minWagePerHour,
}: {
  workers: WorkerRow[];
  minWagePerHour: number;
}) {
  const flagged = workers.filter((w) => hasWageViolation(w, minWagePerHour));
  if (flagged.length === 0) return null;
  return (
    <Box mb={3} p={2} bg="red.50" borderWidth="1px" borderColor="red.300" rounded="md">
      <Text fontSize="xs" color="red.900" fontWeight="semibold">
        Below ${minWagePerHour.toFixed(2)}/hr floor in window: {flagged.length} W-2 worker{flagged.length === 1 ? "" : "s"}
      </Text>
      <Text fontSize="2xs" color="red.800" mt={0.5}>
        Minimum-wage law applies to W-2 employees and trainees. Review the flagged rows before running payroll.
      </Text>
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

// Same shape as BreakdownStat but the value is a copy-to-clipboard
// button — the Gusto payroll workflow is "read one number here, type
// it there," so the button target is the point of the panel. `color`
// is the value's text color (used e.g. red for below-min-wage rates);
// omit to inherit the default.
function PayrollStat({
  label,
  display,
  copyValue,
  bold,
  color,
  width,
}: {
  label: string;
  display: string;
  copyValue: string;
  bold?: boolean;
  color?: string;
  /** Column width — same value across a whole column of rows so cells
   *  line up vertically for at-a-glance scanning. */
  width?: string;
}) {
  return (
    <Box w={width} minW={width}>
      <Text fontSize="2xs" color="fg.muted">{label}</Text>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void copyToClipboard(copyValue)}
        title="Click to copy"
        fontFamily="mono"
        fontWeight={bold ? "bold" : undefined}
        color={color}
        px={1}
        justifyContent="flex-start"
        w="full"
      >
        {display}
      </Button>
    </Box>
  );
}
