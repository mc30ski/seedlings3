"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Card, HStack, Heading, Input, Spinner, Switch, Text, VStack } from "@chakra-ui/react";
import { FiDownload, FiTrash2 } from "react-icons/fi";
import { apiGet, apiDownload, apiDelete } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { usePersistedState } from "@/src/lib/usePersistedState";

type Cadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY";

type UnmappedRow = {
  ref: string;
  date: string;
  description: string;
  category: string;
  amount: number;
};

type Preview = {
  gustoW2: {
    workers: number;
    hours: number;
    gross: number;
    // Count of occurrences in the window whose hours haven't been admin-
    // approved and were therefore excluded from the W-2 export. Surfaces as
    // a pre-download warning with a deep-link into the Jobs filter.
    unapprovedOccurrences: number;
  };
  gustoContractors: { workers: number; gross: number };
  qbIncome: { rows: number; total: number };
  qbExpenses: {
    rows: number;
    total: number;
    businessExpenseTotal: number;
    processorFeeTotal: number;
    contractLaborTotal: number;
    // Non-empty when one or more rows have no QB account mapping in
    // EXPENSE_CATEGORIES. Their presence BLOCKS qb-expenses + qb-bundle
    // downloads — the operator must fix the taxonomy in Settings first.
    unmappedRows: UnmappedRow[];
  };
  qbEquity: {
    rows: number;
    contributionTotal: number;
    drawTotal: number;
  };
  qbFixedAssets: { rows: number; total: number; threshold: number };
};

type HistoryRow = {
  id: string;
  createdAt: string;
  kind:
    | "GUSTO_W2"
    | "GUSTO_CONTRACTORS"
    | "GUSTO_BUNDLE"
    | "QB_INCOME"
    | "QB_EXPENSES"
    | "QB_EQUITY"
    | "QB_FIXED_ASSETS"
    | "QB_BUNDLE";
  rangeStart: string;
  rangeEnd: string;
  rowCount: number;
  totalAmount: number;
  fileName: string;
  contentType: string;
  createdBy: { id: string; displayName: string | null; email: string | null };
};

const KIND_LABELS: Record<HistoryRow["kind"], string> = {
  GUSTO_W2: "Gusto W-2",
  GUSTO_CONTRACTORS: "Gusto 1099",
  GUSTO_BUNDLE: "Gusto Bundle (zip)",
  QB_INCOME: "QB Income",
  QB_EXPENSES: "QB Expenses",
  QB_EQUITY: "QB Equity",
  QB_FIXED_ASSETS: "QB Fixed Assets",
  QB_BUNDLE: "QB Bundle (zip)",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Returns the Monday on/before the given date (local time).
function mondayOnOrBefore(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay(); // Sun=0..Sat=6
  const delta = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + delta);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

// Compute "Last period" and "This period" for a given cadence (local time).
// Last period = most recent CLOSED period (the one you'd run payroll on).
// This period = the period currently in progress.
function periodFor(cadence: Cadence, kind: "this" | "last"): { from: string; to: string } {
  const today = new Date();
  if (cadence === "WEEKLY") {
    const thisStart = mondayOnOrBefore(today);
    const start = kind === "this" ? thisStart : addDays(thisStart, -7);
    const end = addDays(start, 6);
    return { from: dateKey(start), to: dateKey(end) };
  }
  if (cadence === "BIWEEKLY") {
    const thisStart = addDays(mondayOnOrBefore(today), -7); // 2-week window containing today
    const start = kind === "this" ? thisStart : addDays(thisStart, -14);
    const end = addDays(start, 13);
    return { from: dateKey(start), to: dateKey(end) };
  }
  // MONTHLY
  const y = today.getFullYear();
  const m = today.getMonth();
  if (kind === "this") {
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    return { from: dateKey(start), to: dateKey(end) };
  }
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  return { from: dateKey(start), to: dateKey(end) };
}

function ytdRange(): { from: string; to: string } {
  const today = new Date();
  return { from: `${today.getFullYear()}-01-01`, to: dateKey(today) };
}

export default function ExportsTab() {
  const [cadence, setCadence] = useState<Cadence>("WEEKLY");
  // Default to "last week total" = today minus 7 days through today, so a
  // freshly-opened tab shows the most-recently-relevant operational window.
  // Cadence presets ("Last week", "This week", etc.) still snap to calendar
  // boundaries when clicked; only the initial state is rolling.
  const initialEnd = new Date();
  const initialStart = addDays(initialEnd, -7);
  const [start, setStart] = useState(dateKey(initialStart));
  const [end, setEnd] = useState(dateKey(initialEnd));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showUnmappedDetails, setShowUnmappedDetails] = useState(false);
  const [showQbHelp, setShowQbHelp] = useState(false);
  const [showGustoHelp, setShowGustoHelp] = useState(false);
  const [showCadenceHelp, setShowCadenceHelp] = useState(false);
  // Hide individual-file download buttons behind a toggle so the bundles
  // (recommended) are the prominent action. Operators who want one specific
  // file can still get to it without leaving the tab.
  const [showGustoIndividual, setShowGustoIndividual] = useState(false);
  const [showQbIndividual, setShowQbIndividual] = useState(false);
  // When ON (default) the server stores an ExportRun row so the bytes are
  // re-downloadable from history. When OFF, the download is delivered but
  // not persisted — useful for spot-check / scratch exports the operator
  // doesn't want polluting the audit history. Persisted so the operator's
  // preference survives reloads.
  const [saveHistory, setSaveHistory] = usePersistedState<boolean>("exports_saveHistory", true);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Two-stage delete flow. Stage 1 asks "Delete this entry?"; stage 2 asks
  // "Are you absolutely sure?" with a stronger warning. The user has to
  // confirm both to actually fire the DELETE request — accidental taps die
  // at stage 1, and stage 2 makes the destructive nature of the action
  // unmissable. `deletingId` powers the per-row button loading state.
  const [deleteTarget, setDeleteTarget] = useState<HistoryRow | null>(null);
  const [deleteStage, setDeleteStage] = useState<1 | 2>(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const rows = await apiGet<HistoryRow[]>("/api/admin/exports/history?limit=50");
      setHistory(Array.isArray(rows) ? rows : []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // Pull cadence setting on mount; if it changes the user can override via the
  // preset buttons. Default range stays whatever was set on first render.
  useEffect(() => {
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const row = rows.find((r) => r.key === "PAYROLL_PERIOD_CADENCE");
        const v = row?.value as Cadence | undefined;
        if (v === "WEEKLY" || v === "BIWEEKLY" || v === "MONTHLY") {
          setCadence(v);
          const r = periodFor(v, "last");
          setStart(r.from);
          setEnd(r.to);
        }
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);

  // Re-fetch preview whenever range changes (debounced by browser; cheap).
  useEffect(() => {
    if (!start || !end || end < start) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    apiGet<Preview>(`/api/admin/exports/preview?start=${start}&end=${end}`)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(getErrorMessage("Preview failed.", err));
        setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [start, end]);

  const presets = useMemo(
    () => [
      { key: "last", label: `Last ${cadence.toLowerCase()}`, range: () => periodFor(cadence, "last") },
      { key: "this", label: `This ${cadence.toLowerCase()}`, range: () => periodFor(cadence, "this") },
      { key: "ytd", label: "Year to date", range: ytdRange },
    ],
    [cadence],
  );

  async function download(slug: string, label: string, ext: "csv" | "zip" = "csv") {
    if (!start || !end || end < start) {
      publishInlineMessage({ type: "WARNING", text: "Pick a valid date range first." });
      return;
    }
    const fn = `${slug}-${start}_${end}.${ext}`;
    setBusyKey(slug);
    try {
      // saveHistory=false tells the server to deliver the bytes without
      // creating an ExportRun row, so the audit history stays clean for
      // ad-hoc spot-check downloads. Default ON.
      const qs = `start=${start}&end=${end}${saveHistory ? "" : "&saveHistory=0"}`;
      await apiDownload(`/api/admin/exports/${slug}.${ext}?${qs}`, fn);
      publishInlineMessage({
        type: "SUCCESS",
        text: saveHistory ? `${label} downloaded.` : `${label} downloaded (not saved to history).`,
      });
      // Re-fetch only if we actually saved to history — otherwise the
      // table won't change.
      if (saveHistory) refreshHistory();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(`${label} download failed.`, err) });
    } finally {
      setBusyKey(null);
    }
  }

  function openDelete(row: HistoryRow) {
    setDeleteTarget(row);
    setDeleteStage(1);
  }
  function closeDelete() {
    setDeleteTarget(null);
    setDeleteStage(1);
  }
  async function performDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeletingId(id);
    closeDelete();
    try {
      await apiDelete(`/api/admin/exports/history/${id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Export history entry deleted." });
      await refreshHistory();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    } finally {
      setDeletingId(null);
    }
  }

  async function downloadHistoric(row: HistoryRow) {
    setBusyKey(`history-${row.id}`);
    try {
      await apiDownload(`/api/admin/exports/history/${row.id}/download`, row.fileName);
      publishInlineMessage({ type: "SUCCESS", text: `${row.fileName} downloaded.` });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Download failed.", err) });
    } finally {
      setBusyKey(null);
    }
  }

  const unmapped = preview?.qbExpenses.unmappedRows ?? [];
  const qbBlocked = unmapped.length > 0;

  return (
    <VStack align="stretch" gap={4} p={4} maxW="900px" mx="auto">
      {/* TEMPORARY — remove once the CPA has confirmed the export design.
          The W-2 export is work-anchored (completion date + promised net),
          which is a deliberate departure from cash-basis. See
          docs/FINANCIAL_SYSTEM.md §12. */}
      <Box
        bg="red.50"
        borderWidth="2px"
        borderColor="red.400"
        borderRadius="md"
        p={3}
      >
        <Text fontSize="sm" fontWeight="bold" color="red.700">
          ⚠ NOT YET CPA-VERIFIED — confirm before using for real payroll/tax filing
        </Text>
        <Text fontSize="xs" color="red.700" mt={1}>
          The W-2 export is anchored on job-completion date with each worker's
          promised net (work-anchored), not on payment confirmation. The 1099
          and QuickBooks exports stay on payment date. Have your CPA confirm
          this matches how payroll and taxes should be filed, then remove this
          banner. Details: docs/FINANCIAL_SYSTEM.md §12.
        </Text>
      </Box>
      <Box>
        <Heading size="md" mb={1}>
          Exports
        </Heading>
        <Text fontSize="sm" color="fg.muted">
          Download CSVs to verify payroll and bookkeeping data before importing into Gusto and
          QuickBooks. All payment-derived rows use cash-basis (anchored on payment confirmation
          date). Configure pay-period cadence in Settings (currently <b>{cadence.toLowerCase()}</b>).
        </Text>
      </Box>

      <Card.Root>
        <Card.Body>
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm" fontWeight="medium">
              Date range
            </Text>
            <HStack gap={2} wrap="wrap">
              <Box>
                <Text fontSize="xs" color="fg.muted" mb={1}>
                  Start
                </Text>
                <Input
                  type="date"
                  value={start}
                  // max=end enforces Start ≤ End at the picker level. The
                  // onChange guard handles the typed-value path (some
                  // browsers still emit the value even when it violates max).
                  max={end || undefined}
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
                <Text fontSize="xs" color="fg.muted" mb={1}>
                  End
                </Text>
                <Input
                  type="date"
                  value={end}
                  // min=start enforces End ≥ Start at the picker level.
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
            {/* Save-to-history toggle. Default ON so the audit trail keeps
                building automatically. Operators flip it off when they're
                grabbing a one-off spot-check file they don't want stored. */}
            <HStack justify="space-between" gap={3} pt={1}>
              <Box flex="1" minW={0}>
                <Text fontSize="sm" fontWeight="medium">
                  Save to history
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {saveHistory
                    ? "Each download is stored so you can re-download the exact same file later from the history table below."
                    : "Downloads will NOT be recorded. Useful for ad-hoc spot-checks; the file is not retrievable from history later."}
                </Text>
              </Box>
              <Switch.Root
                checked={saveHistory}
                onCheckedChange={(e) => setSaveHistory(!!e.checked)}
                colorPalette="green"
              >
                <Switch.HiddenInput />
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Root>
            </HStack>
          </VStack>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Body>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" fontWeight="medium">
              Preview totals
            </Text>
            {previewLoading && <Spinner size="sm" />}
          </HStack>
          {previewError ? (
            <Text fontSize="sm" color="red.600">
              {previewError}
            </Text>
          ) : preview ? (
            <VStack align="stretch" gap={1} fontSize="sm">
              <HStack justify="space-between">
                <Text color="fg.muted">Gusto W-2 (employees + trainees):</Text>
                <Text>
                  {preview.gustoW2.workers} worker{preview.gustoW2.workers === 1 ? "" : "s"}
                  {" · "}
                  {preview.gustoW2.hours.toFixed(2)} hrs{" · "}
                  <b>${preview.gustoW2.gross.toFixed(2)}</b>
                </Text>
              </HStack>
              <HStack justify="space-between">
                <Text color="fg.muted">Gusto 1099 (contractors):</Text>
                <Text>
                  {preview.gustoContractors.workers} contractor
                  {preview.gustoContractors.workers === 1 ? "" : "s"}
                  {" · "}
                  <b>${preview.gustoContractors.gross.toFixed(2)}</b>
                </Text>
              </HStack>
              <HStack justify="space-between">
                <Text color="fg.muted">QB Income (confirmed payments):</Text>
                <Text>
                  {preview.qbIncome.rows} payment{preview.qbIncome.rows === 1 ? "" : "s"}{" · "}
                  <b>${preview.qbIncome.total.toFixed(2)}</b>
                </Text>
              </HStack>
              <HStack justify="space-between">
                <Text color="fg.muted">QB Expenses (BusinessExpense + fees + contractors):</Text>
                <Text>
                  {preview.qbExpenses.rows} row{preview.qbExpenses.rows === 1 ? "" : "s"}{" · "}
                  <b>${preview.qbExpenses.total.toFixed(2)}</b>
                </Text>
              </HStack>
              {preview.qbExpenses.processorFeeTotal > 0 && (
                <HStack justify="space-between" pl={4} fontSize="xs">
                  <Text color="fg.muted">↳ Payment Processing Fees:</Text>
                  <Text color="fg.muted">
                    <b>${preview.qbExpenses.processorFeeTotal.toFixed(2)}</b>
                  </Text>
                </HStack>
              )}
              {preview.qbExpenses.contractLaborTotal > 0 && (
                <HStack justify="space-between" pl={4} fontSize="xs">
                  <Text color="fg.muted">↳ Contract Labor:</Text>
                  <Text color="fg.muted">
                    <b>${preview.qbExpenses.contractLaborTotal.toFixed(2)}</b>
                  </Text>
                </HStack>
              )}
              {preview.qbFixedAssets.rows > 0 && (
                <HStack justify="space-between">
                  <Text color="fg.muted">
                    QB Fixed Assets (capital purchases ≥ ${preview.qbFixedAssets.threshold}):
                  </Text>
                  <Text>
                    {preview.qbFixedAssets.rows} asset{preview.qbFixedAssets.rows === 1 ? "" : "s"}{" · "}
                    <b>${preview.qbFixedAssets.total.toFixed(2)}</b>
                  </Text>
                </HStack>
              )}
              {preview.qbEquity.rows > 0 && (
                <>
                  <HStack justify="space-between">
                    <Text color="fg.muted">QB Equity (contributions + draws):</Text>
                    <Text>
                      {preview.qbEquity.rows} row{preview.qbEquity.rows === 1 ? "" : "s"}{" · "}
                      <b>
                        ${(preview.qbEquity.contributionTotal + preview.qbEquity.drawTotal).toFixed(2)}
                      </b>
                    </Text>
                  </HStack>
                  {preview.qbEquity.contributionTotal > 0 && (
                    <HStack justify="space-between" pl={4} fontSize="xs">
                      <Text color="fg.muted">↳ Capital Contributions:</Text>
                      <Text color="fg.muted">
                        <b>${preview.qbEquity.contributionTotal.toFixed(2)}</b>
                      </Text>
                    </HStack>
                  )}
                  {preview.qbEquity.drawTotal > 0 && (
                    <HStack justify="space-between" pl={4} fontSize="xs">
                      <Text color="fg.muted">↳ Owner Draws:</Text>
                      <Text color="fg.muted">
                        <b>${preview.qbEquity.drawTotal.toFixed(2)}</b>
                      </Text>
                    </HStack>
                  )}
                </>
              )}
            </VStack>
          ) : (
            <Text fontSize="sm" color="fg.muted">
              Pick a date range to see totals.
            </Text>
          )}
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Body>
          <HStack justify="space-between" mb={2} wrap="wrap" gap={2}>
            <Text fontSize="sm" fontWeight="medium">Gusto</Text>
            <HStack gap={2} wrap="wrap">
              {/* Cadence info — separate from the per-file explainer because
                  it's workflow/timing, not file content. Opening one info
                  panel closes the other so only one is visible at a time. */}
              <Box
                as="button"
                onClick={() => {
                  setShowCadenceHelp((v) => !v);
                  setShowGustoHelp(false);
                }}
                display="inline-flex"
                alignItems="center"
                gap={1.5}
                px={2.5}
                py={1}
                bg="blue.50"
                color="blue.700"
                borderWidth="1px"
                borderColor="blue.300"
                borderRadius="full"
                fontSize="xs"
                fontWeight="medium"
                cursor="pointer"
                _hover={{ bg: "blue.100", borderColor: "blue.400" }}
                aria-expanded={showCadenceHelp}
              >
                <Box
                  as="span"
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  w="14px"
                  h="14px"
                  borderRadius="full"
                  bg="blue.500"
                  color="white"
                  fontSize="2xs"
                  fontWeight="bold"
                  lineHeight="1"
                >
                  i
                </Box>
                Pay cadence {showCadenceHelp ? "↑" : "↓"}
              </Box>
              {/* Blue pill info indicator — same pattern as the QuickBooks
                  "Explain these files" affordance above so the operator
                  learns both surfaces the same way. Mutually exclusive with
                  the cadence panel so only one is open at a time. */}
              <Box
                as="button"
                onClick={() => {
                  setShowGustoHelp((v) => !v);
                  setShowCadenceHelp(false);
                }}
                display="inline-flex"
                alignItems="center"
                gap={1.5}
                px={2.5}
                py={1}
                bg="blue.50"
                color="blue.700"
                borderWidth="1px"
                borderColor="blue.300"
                borderRadius="full"
                fontSize="xs"
                fontWeight="medium"
                cursor="pointer"
                _hover={{ bg: "blue.100", borderColor: "blue.400" }}
                aria-expanded={showGustoHelp}
              >
                <Box
                  as="span"
                  display="inline-flex"
                  alignItems="center"
                  justifyContent="center"
                  w="14px"
                  h="14px"
                  borderRadius="full"
                  bg="blue.500"
                  color="white"
                  fontSize="2xs"
                  fontWeight="bold"
                  lineHeight="1"
                >
                  i
                </Box>
                Explain these files {showGustoHelp ? "↑" : "↓"}
              </Box>
            </HStack>
          </HStack>
          {showCadenceHelp && (
            <Box
              mb={3}
              p={3}
              bg="blue.50"
              borderWidth="1px"
              borderColor="blue.300"
              borderLeftWidth="4px"
              borderLeftColor="blue.500"
              rounded="md"
            >
              <VStack align="stretch" gap={3} fontSize="sm" color="blue.900">
                <Box>
                  <Text fontWeight="semibold" mb={1}>Pay period cadence — weekly (recommended)</Text>
                  <Text>
                    Weekly pay periods are the natural fit for Seedlings:
                  </Text>
                  <Text as="ul" pl={4} mt={1}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Matches job rhythm</Text> — most recurring clients are weekly, so workers get paid for the jobs they just finished rather than work from two weeks ago.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Cash flow + retention</Text> — every-week deposits read as a real paycheck; better for worker budgeting and stickiness.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Clean 7-day windows</Text> — easy reconciliation: jobs → payments → CSV → Gusto, no overlap with prior periods.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Piece-rate-friendly</Text> — pay varies by jobs completed; weekly keeps payouts predictable and small instead of large biweekly lumps.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>The weekly rhythm</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mon–Sun</Text>: workers complete jobs; the app tracks earnings.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mon morning</Text>: download <code>gusto-w2.csv</code> and <code>gusto-contractors.csv</code> from the date range above (defaults to last week).
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mon</Text>: in Gusto, submit the W-2 payroll run first (after the min-wage check), then the contractor payment run.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Wed</Text>: Gusto direct deposits land in worker accounts (typical 2-business-day lag).
                    </Text>
                    <Text as="li">Next Mon: repeat.</Text>
                  </Text>
                </Box>

                <Text fontSize="xs" color="blue.800">
                  The default date range on this tab follows the
                  {" "}<Text as="span" fontWeight="semibold">PAYROLL_PERIOD_CADENCE</Text> setting
                  (currently <Text as="span" fontWeight="semibold">{cadence.toLowerCase()}</Text>).
                  Change it in Settings → Payments &amp; Payouts to switch the
                  default preset (weekly / biweekly / monthly).
                </Text>
              </VStack>
            </Box>
          )}
          {showGustoHelp && (
            <Box
              mb={3}
              p={3}
              bg="blue.50"
              borderWidth="1px"
              borderColor="blue.300"
              borderLeftWidth="4px"
              borderLeftColor="blue.500"
              rounded="md"
            >
              <VStack align="stretch" gap={3} fontSize="sm" color="blue.900">
                <Text>
                  The app calculates each worker's pay-period totals; you
                  transcribe the dollar amounts into a Gusto payroll run.
                  Gusto handles withholding, direct deposit, year-end forms,
                  and QuickBooks sync. No API integration yet — manual paste
                  per pay period.
                </Text>

                {/* Clean-rule callout — boundary between what the app
                    computes vs what Gusto does on top. Mirrors the QB
                    callout's visual treatment so the two are scannable. */}
                <Box
                  bg="white"
                  borderWidth="1px"
                  borderColor="blue.300"
                  borderLeftWidth="4px"
                  borderLeftColor="green.500"
                  rounded="md"
                  p={2.5}
                >
                  <Text fontWeight="semibold" mb={1}>The clean rule</Text>
                  <Text as="ul" pl={4} gap={0.5}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">App</Text> calculates dollar amounts and hours.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Gusto</Text> pays workers, withholds taxes (W-2 only), files forms, and posts the expense to QuickBooks.
                    </Text>
                  </Text>
                </Box>

                {/* Piece-rate explainer — the dollar amounts in both CSVs
                    aren't hourly; they're per-job. This block exposes the
                    formula so the operator can sanity-check any row. */}
                <Box>
                  <Text fontWeight="semibold" mb={1}>How the dollar amounts are calculated (piece-rate)</Text>
                  <Text>
                    Workers are paid <Text as="span" fontWeight="semibold">per job</Text>, not per
                    hour. For each job: <Text as="span" fontWeight="semibold">net = (price + add-ons) − expenses</Text>.
                    The business takes a percentage off that net and the rest is the worker's payout.
                    The percentage is configured in
                    {" "}<Text as="span" fontWeight="semibold">Settings → Payments &amp; Payouts</Text>:
                  </Text>
                  <Text as="ul" pl={4} mt={1}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">W-2 employee / trainee</Text> —
                      {" "}<Text as="span" fontWeight="semibold">payout = net × (1 − EMPLOYEE_BUSINESS_MARGIN_PERCENT / 100)</Text>.
                      Default: 30% margin → worker gets 70%. The 30% covers business overhead
                      (insurance, equipment depreciation, admin time).
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">1099 contractor</Text> —
                      {" "}<Text as="span" fontWeight="semibold">payout = net × (1 − CONTRACTOR_PLATFORM_FEE_PERCENT / 100)</Text>.
                      Default: 20% platform fee → contractor keeps 80%.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Multi-worker jobs</Text> — the per-job
                      payout is split across the non-observer assignees. Default is even split; the
                      claimer or an admin can override per-worker percentages at completion.
                    </Text>
                  </Text>
                  <Text fontSize="xs" mt={1.5} color="blue.800">
                    Hours Worked is tracked separately and used only for the minimum-wage compliance
                    check on the W-2 file. The piece-rate formula itself never uses hours.
                  </Text>
                </Box>

                {/* Per-file breakdown */}
                <Box>
                  <Text fontWeight="semibold" mb={1}>1. gusto-w2.csv — employees + trainees</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">
                      Key fields: <Text as="span" fontWeight="semibold">Gross Pay</Text> (pre-tax) and
                      {" "}<Text as="span" fontWeight="semibold">Hours Worked</Text>.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">In Gusto:</Text> start a payroll run, enter each row's Gross Pay against the matching worker (email-matched).
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Min-wage check before submitting:</Text>
                      {" "}Gross Pay ÷ Hours Worked must be ≥ <Text as="span" fontWeight="semibold">$7.25</Text> federal floor.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Gusto auto-handles:</Text> federal + NC state withholding, employee FICA (7.65%), employer FICA match, direct deposit, W-2 generation, QB sync.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>2. gusto-contractors.csv — 1099 contractors</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">
                      Key field: <Text as="span" fontWeight="semibold">Total Paid</Text> (already net of the configured platform fee).
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">In Gusto:</Text> create a contractor payment run, enter each row's Total Paid against the matching contractor.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Gusto auto-handles:</Text> direct deposit, 1099-NEC at year-end for any contractor paid ≥ $600, QB sync.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Gusto does NOT:</Text> withhold taxes — contractors handle their own income tax + self-employment tax.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>Each pay period (default weekly)</Text>
                  <Text>
                    Pick the range above → download both CSVs → in Gusto, run W-2 payroll first
                    (verify min wage), then the contractor payment run. Gusto handles deposits,
                    filings, and the QB sync from there.
                  </Text>
                </Box>

                {/* Bottom-line summary table — W-2 vs Contractor at a glance.
                    Same compact-grid pattern as the QB summary above. */}
                <Box borderWidth="1px" borderColor="blue.200" rounded="md" overflow="hidden" bg="white">
                  <HStack gap={0} bg="blue.100" px={2} py={1} fontSize="xs" fontWeight="semibold" color="blue.900">
                    <Text flex="1.2">File</Text>
                    <Text flex="1.4">Pay field</Text>
                    <Text flex="1.4">Tax withholding</Text>
                    <Text flex="1.2">Year-end form</Text>
                  </HStack>
                  {[
                    { file: "gusto-w2.csv", field: "Gross Pay (pre-tax)", withholding: "Yes — Gusto handles", form: "W-2" },
                    { file: "gusto-contractors.csv", field: "Total Paid (post-fee)", withholding: "No — contractor's job", form: "1099-NEC if ≥ $600" },
                  ].map((row) => (
                    <HStack key={row.file} gap={0} px={2} py={1.5} fontSize="xs" borderTopWidth="1px" borderColor="blue.100">
                      <Text flex="1.2" fontWeight="medium" color="blue.900">{row.file}</Text>
                      <Text flex="1.4" color="blue.800">{row.field}</Text>
                      <Text flex="1.4" color="blue.800">{row.withholding}</Text>
                      <Text flex="1.2" color="blue.800">{row.form}</Text>
                    </HStack>
                  ))}
                </Box>

                <Text fontSize="xs" color="blue.800">
                  Worker email in each CSV must match the email on file in Gusto exactly — that's
                  the field Gusto matches on when you transcribe.
                </Text>
              </VStack>
            </Box>
          )}
          {/* Pre-download warning: occurrences in the selected range whose
              hours haven't been admin-approved are excluded from the W-2
              export. The banner only renders when there's something to flag;
              the deep-link jumps into the Jobs tab filtered to those rows. */}
          {preview && preview.gustoW2.unapprovedOccurrences > 0 && (
            <Box mb={2} p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
              <HStack justify="space-between" gap={2} wrap="wrap">
                <Text fontSize="xs" color="orange.800">
                  <Text as="span" fontWeight="semibold">
                    {preview.gustoW2.unapprovedOccurrences} occurrence
                    {preview.gustoW2.unapprovedOccurrences === 1 ? "" : "s"}
                  </Text>
                  {" "}with unapproved hours
                  {" "}will be excluded from the W-2 CSV.
                </Text>
                <Button
                  size="xs"
                  variant="outline"
                  colorPalette="orange"
                  onClick={() => {
                    try {
                      localStorage.setItem("seedlings_adminJobs_showUnapprovedHours", "1");
                    } catch {}
                    window.dispatchEvent(new CustomEvent("navigate:adminTab", { detail: { tab: "admin-jobs", remount: true } }));
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent("adminJobs:showUnapprovedHours"));
                    }, 100);
                  }}
                >
                  Review now
                </Button>
              </HStack>
            </Box>
          )}
          <VStack align="stretch" gap={2}>
            {/* Bundle = recommended path. Solid button + tooltip steers
                operators to grab both Gusto CSVs in one click each pay
                period instead of two separate downloads. */}
            <Button
              variant="solid"
              colorPalette="blue"
              size="sm"
              loading={busyKey === "gusto-bundle"}
              onClick={() => download("gusto-bundle", "Gusto Bundle (zip)", "zip")}
              title="W-2 + Contractors CSVs in a single zip"
            >
              <FiDownload /> Download Gusto Bundle (zip)
            </Button>
            {/* Individual file downloads — hidden by default. Power users
                can expand if they need to grab just one file. */}
            <Button
              size="xs"
              variant="ghost"
              alignSelf="start"
              onClick={() => setShowGustoIndividual((v) => !v)}
            >
              {showGustoIndividual ? "Hide individual files ↑" : "Show individual files ↓"}
            </Button>
            {showGustoIndividual && (
              <VStack align="stretch" gap={2}>
                <Button
                  variant="outline"
                  colorPalette="blue"
                  size="sm"
                  loading={busyKey === "gusto-w2"}
                  onClick={() => download("gusto-w2", "Gusto W-2 CSV")}
                >
                  <FiDownload /> Download W-2 CSV
                </Button>
                <Button
                  variant="outline"
                  colorPalette="blue"
                  size="sm"
                  loading={busyKey === "gusto-contractors"}
                  onClick={() => download("gusto-contractors", "Gusto Contractors CSV")}
                >
                  <FiDownload /> Download Contractors CSV
                </Button>
              </VStack>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Body>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" fontWeight="medium">QuickBooks</Text>
            {/* Blue pill-style info indicator — matches the lightweight
                "informational" affordance pattern (rounded full, blue tint,
                ⓘ icon-like dot) used elsewhere for collapsible explainers. */}
            <Box
              as="button"
              onClick={() => setShowQbHelp((v) => !v)}
              display="inline-flex"
              alignItems="center"
              gap={1.5}
              px={2.5}
              py={1}
              bg="blue.50"
              color="blue.700"
              borderWidth="1px"
              borderColor="blue.300"
              borderRadius="full"
              fontSize="xs"
              fontWeight="medium"
              cursor="pointer"
              _hover={{ bg: "blue.100", borderColor: "blue.400" }}
              aria-expanded={showQbHelp}
            >
              <Box
                as="span"
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                w="14px"
                h="14px"
                borderRadius="full"
                bg="blue.500"
                color="white"
                fontSize="2xs"
                fontWeight="bold"
                lineHeight="1"
              >
                i
              </Box>
              Explain these files {showQbHelp ? "↑" : "↓"}
            </Box>
          </HStack>
          {showQbHelp && (
            <Box
              mb={3}
              p={3}
              bg="blue.50"
              borderWidth="1px"
              borderColor="blue.300"
              borderLeftWidth="4px"
              borderLeftColor="blue.500"
              rounded="md"
            >
              <VStack align="stretch" gap={3} fontSize="sm" color="blue.900">
                <Text>
                  QuickBooks imports each transaction type through a different
                  channel, so they have to ship as separate files. Each file
                  also has a different level of mapping complexity — only
                  Expenses needs configurable account names.
                </Text>

                {/* Worker-payments callout — clarifies the Gusto vs CSV
                    boundary, which is the most common point of confusion
                    when reading this panel. */}
                <Box
                  bg="white"
                  borderWidth="1px"
                  borderColor="blue.300"
                  borderLeftWidth="4px"
                  borderLeftColor="green.500"
                  rounded="md"
                  p={2.5}
                >
                  <Text fontWeight="semibold" mb={1}>The clean rule for worker pay vs. job expenses</Text>
                  <Text as="ul" pl={4} gap={0.5}>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Worker payments of any kind</Text> (W-2 employee wages AND 1099 contractor payouts) flow
                      {" "}<Text as="span" fontWeight="semibold">through Gusto → QuickBooks</Text> directly. Gusto's QB integration posts them on its own.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Everything else job-related</Text> (materials, processor fees, business overhead, asset purchases, etc.) flows
                      {" "}<Text as="span" fontWeight="semibold">through this app's CSV → QuickBooks</Text> via the files below.
                    </Text>
                  </Text>
                  <Text fontSize="xs" mt={1.5} color="blue.800">
                    Note: the app's current Expenses CSV does emit one
                    {" "}<i>Contract Labor</i> row per contractor PaymentSplit (from earlier Phase 2 work),
                    and the EXPENSE_CATEGORIES taxonomy maps it to QB's
                    Contract Labor account. If Gusto is also syncing those contractor payments to QB,
                    skip the Contract Labor rows on import to avoid double-counting — or remove the
                    Contract Labor mapping from EXPENSE_CATEGORIES so they land as <i>Unmapped</i> for
                    a manual decision per row.
                  </Text>
                </Box>

                {/* Per-file breakdown: what it is + how rows map to QB
                    accounts. The "mapping" line is the part that drove the
                    EXPENSE_CATEGORIES settings UI. */}
                <Box>
                  <Text fontWeight="semibold" mb={1}>1. Income — client payments</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">Imports into QuickBooks as Sales/Income.</Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mapping: hardcoded.</Text>
                      {" "}Only 1–2 accounts ever — Services and Equipment Rental Income.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>2. Expenses — job materials, processor fees, business overhead</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">Imports into QuickBooks as Expense transactions.</Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">What's in it:</Text>
                      {" "}job materials (mulch, supplies), processor fees (Venmo, Stripe, etc.),
                      business overhead (software, subscriptions, insurance, etc.), equipment rental charges.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">What's NOT in it:</Text>
                      {" "}W-2 employee wages and (by design) 1099 contractor payouts —
                      both are Gusto's job. See the green-bar callout above for the Contract Labor edge case.
                    </Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mapping: configurable</Text> via
                      {" "}<Text as="span" fontWeight="semibold">Settings → EXPENSE_CATEGORIES</Text>.
                      Many categories, each maps to a different QB account name
                      (Supplies, Vehicle Maintenance & Repairs, Software & Subscriptions, etc.).
                      Account names vary by QB setup, and operators can add new
                      categories any time — that's why this file gets the
                      dedicated settings screen.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>3. Equity — owner draws and contributions</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">Imports into QuickBooks as Journal Entries (balance sheet, not P&L).</Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mapping: hardcoded.</Text>
                      {" "}Exactly 2 accounts — Owner Draws and Owner Investments.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>4. Fixed Assets — equipment ≥ the capitalization threshold</Text>
                  <Text as="ul" pl={4}>
                    <Text as="li">Imports via the Fixed Asset manager. Depreciated over the asset's life — not expensed immediately.</Text>
                    <Text as="li">
                      <Text as="span" fontWeight="semibold">Mapping: hardcoded.</Text>
                      {" "}Equipment purchases above the threshold are auto-flagged as Fixed Assets — single account type.
                    </Text>
                  </Text>
                </Box>

                <Box>
                  <Text fontWeight="semibold" mb={1}>Import order in QuickBooks</Text>
                  <Text>Income → Expenses → Equity → Fixed Assets.</Text>
                </Box>

                {/* Compact summary table — mirrors the "bottom line" view of
                    why only Expenses needs the configurable mapping screen.
                    Plain Box grid keeps it readable on narrow viewports
                    without pulling in a real Table component. */}
                <Box borderWidth="1px" borderColor="blue.200" rounded="md" overflow="hidden" bg="white">
                  <HStack gap={0} bg="blue.100" px={2} py={1} fontSize="xs" fontWeight="semibold" color="blue.900">
                    <Text flex="1">File</Text>
                    <Text flex="1.2">Mapping</Text>
                    <Text flex="2">Why</Text>
                  </HStack>
                  {[
                    { file: "Income", mapping: "Hardcoded", why: "Simple — 1–2 accounts only" },
                    { file: "Expenses", mapping: "Configurable settings", why: "Complex — many categories" },
                    { file: "Equity", mapping: "Hardcoded", why: "Simple — 2 accounts only" },
                    { file: "Assets", mapping: "Hardcoded", why: "Simple — fixed asset type" },
                  ].map((row) => (
                    <HStack key={row.file} gap={0} px={2} py={1.5} fontSize="xs" borderTopWidth="1px" borderColor="blue.100">
                      <Text flex="1" fontWeight="medium" color="blue.900">{row.file}</Text>
                      <Text flex="1.2" color="blue.800">{row.mapping}</Text>
                      <Text flex="2" color="blue.800">{row.why}</Text>
                    </HStack>
                  ))}
                </Box>

                <Text fontSize="xs" color="blue.800">
                  Use <Text as="span" fontWeight="semibold">Download QB Bundle (zip)</Text> below
                  to grab all four at once for the selected date range.
                </Text>
              </VStack>
            </Box>
          )}
          {qbBlocked && (
            <Box
              mb={3}
              p={2}
              bg="red.50"
              borderWidth="1px"
              borderColor="red.300"
              borderRadius="md"
            >
              <HStack justify="space-between" gap={2} wrap="wrap">
                <Text fontSize="xs" color="red.800">
                  <Text as="span" fontWeight="semibold">
                    {unmapped.length} expense row
                    {unmapped.length === 1 ? "" : "s"} with no QB account mapping
                  </Text>
                  {" — "}
                  the Expenses CSV and Bundle are blocked. Map the categories
                  in Settings → EXPENSE_CATEGORIES (set <code>qbAccount</code>),
                  then reload.
                </Text>
                <Button
                  size="xs"
                  variant="outline"
                  colorPalette="red"
                  onClick={() => setShowUnmappedDetails((v) => !v)}
                >
                  {showUnmappedDetails ? "Hide details" : "Show details"}
                </Button>
              </HStack>
              {showUnmappedDetails && (
                <Box mt={2} maxH="240px" overflowY="auto" borderTopWidth="1px" borderColor="red.200" pt={2}>
                  <VStack align="stretch" gap={1}>
                    {unmapped.map((r) => (
                      <HStack key={r.ref} fontSize="xs" gap={2} wrap="wrap">
                        <Text color="red.700" fontFamily="mono">
                          {r.ref}
                        </Text>
                        <Text color="fg.muted">{r.date}</Text>
                        <Text color="red.800" fontWeight="semibold">
                          {r.category}
                        </Text>
                        <Text color="fg.muted" truncate>
                          {r.description}
                        </Text>
                        <Text color="fg.muted" ml="auto">
                          ${r.amount.toFixed(2)}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
                </Box>
              )}
            </Box>
          )}
          <VStack align="stretch" gap={2}>
            {/* Bundle = recommended path. Individual files hidden by default
                so the operator's eye lands on the all-in-one zip first. */}
            <Button
              variant="solid"
              colorPalette="green"
              size="sm"
              loading={busyKey === "qb-bundle"}
              disabled={qbBlocked}
              onClick={() => download("qb-bundle", "QB Bundle (zip)", "zip")}
              title={qbBlocked ? "Fix unmapped rows before downloading the bundle" : "Income + Expenses + Equity + Fixed Assets in a single zip"}
            >
              <FiDownload /> Download QB Bundle (zip)
            </Button>
            <Button
              size="xs"
              variant="ghost"
              alignSelf="start"
              onClick={() => setShowQbIndividual((v) => !v)}
            >
              {showQbIndividual ? "Hide individual files ↑" : "Show individual files ↓"}
            </Button>
            {showQbIndividual && (
              <VStack align="stretch" gap={2}>
                <Button
                  variant="outline"
                  colorPalette="green"
                  size="sm"
                  loading={busyKey === "qb-income"}
                  onClick={() => download("qb-income", "QB Income CSV")}
                >
                  <FiDownload /> Download Income CSV
                </Button>
                <Button
                  variant="outline"
                  colorPalette="green"
                  size="sm"
                  loading={busyKey === "qb-expenses"}
                  disabled={qbBlocked}
                  onClick={() => download("qb-expenses", "QB Expenses CSV")}
                  title={qbBlocked ? "Fix unmapped rows before downloading expenses" : undefined}
                >
                  <FiDownload /> Download Expenses CSV
                </Button>
                <Button
                  variant="outline"
                  colorPalette="green"
                  size="sm"
                  loading={busyKey === "qb-equity"}
                  onClick={() => download("qb-equity", "QB Equity CSV")}
                  title="Capital contributions + owner draws — equity account movements (not P&L)"
                >
                  <FiDownload /> Download Equity CSV
                </Button>
                <Button
                  variant="outline"
                  colorPalette="green"
                  size="sm"
                  loading={busyKey === "qb-fixed-assets"}
                  onClick={() => download("qb-fixed-assets", "QB Fixed Assets CSV")}
                  title={`Capital purchases ≥ $${preview?.qbFixedAssets.threshold ?? 500} on/after the policy start date — imported into QB Fixed Asset accounts, not P&L`}
                >
                  <FiDownload /> Download Fixed Assets CSV
                </Button>
              </VStack>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Body>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" fontWeight="medium">
              Export history
            </Text>
            <HStack gap={2}>
              {historyLoading && <Spinner size="sm" />}
              <Button size="xs" variant="ghost" onClick={refreshHistory}>
                Refresh
              </Button>
            </HStack>
          </HStack>
          {!history || history.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">
              No exports yet. Downloads will appear here for re-download.
            </Text>
          ) : (
            <VStack align="stretch" gap={1}>
              {history.map((row) => {
                const created = new Date(row.createdAt);
                const rs = row.rangeStart.slice(0, 10);
                const re = row.rangeEnd.slice(0, 10);
                return (
                  <HStack
                    key={row.id}
                    justify="space-between"
                    gap={2}
                    fontSize="xs"
                    py={1}
                    borderBottomWidth="1px"
                    borderColor="border.subtle"
                  >
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontWeight="semibold">
                        {KIND_LABELS[row.kind]} · {rs} → {re}
                      </Text>
                      <Text color="fg.muted" truncate>
                        {created.toLocaleString()} ·{" "}
                        {row.createdBy.displayName || row.createdBy.email || "—"} ·{" "}
                        {row.rowCount} row{row.rowCount === 1 ? "" : "s"} · $
                        {row.totalAmount.toFixed(2)}
                      </Text>
                    </VStack>
                    <HStack gap={1} flexShrink={0}>
                      <Button
                        size="xs"
                        variant="outline"
                        loading={busyKey === `history-${row.id}`}
                        onClick={() => downloadHistoric(row)}
                      >
                        <FiDownload /> Re-download
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        loading={deletingId === row.id}
                        onClick={() => openDelete(row)}
                        title="Permanently delete this entry"
                      >
                        <FiTrash2 />
                      </Button>
                    </HStack>
                  </HStack>
                );
              })}
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      <Box fontSize="xs" color="fg.muted" pl={1}>
        Each CSV ends with a <b>TOTALS</b> row. Compare against the Admin Money tab summary to
        verify before importing into Gusto/QuickBooks.
      </Box>

      {/* Two-stage delete confirmation. Stage 1 is the normal "you sure?";
          Stage 2 is the "REALLY sure?" with stronger warning copy and the
          destructive button label. Both must pass before the row goes. */}
      {deleteTarget && deleteStage === 1 && (
        <ConfirmDialog
          open={true}
          title="Delete export entry?"
          message={`Remove the ${KIND_LABELS[deleteTarget.kind]} entry from ${deleteTarget.rangeStart.slice(0, 10)} → ${deleteTarget.rangeEnd.slice(0, 10)} (${deleteTarget.fileName})?`}
          warning="This permanently removes the saved CSV/zip snapshot. The underlying tax and payroll data is not affected, but the previously-downloaded file bytes will be gone — if you need them again you'll have to re-export, and the numbers may differ if records have changed since."
          confirmLabel="Continue…"
          confirmColorPalette="red"
          onConfirm={() => setDeleteStage(2)}
          onCancel={closeDelete}
        />
      )}
      {deleteTarget && deleteStage === 2 && (
        <ConfirmDialog
          open={true}
          title="Are you absolutely sure?"
          message={`Final confirmation — delete ${deleteTarget.fileName}? There is no undo.`}
          warning="Once you tap Delete Forever, the snapshot is removed immediately from the database. There is no recycle bin and no recovery path."
          confirmLabel="Delete Forever"
          confirmColorPalette="red"
          cancelLabel="Cancel"
          onConfirm={() => void performDelete()}
          onCancel={closeDelete}
        />
      )}
    </VStack>
  );
}
