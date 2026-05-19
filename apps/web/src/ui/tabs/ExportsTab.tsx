"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Button, Card, HStack, Heading, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiDownload } from "react-icons/fi";
import { apiGet, apiDownload } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";

type Cadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY";

type Preview = {
  gustoW2: { workers: number; hours: number; gross: number };
  gustoContractors: { workers: number; gross: number };
  qbIncome: { rows: number; total: number };
  qbExpenses: { rows: number; total: number };
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
  const initial = periodFor("WEEKLY", "last");
  const [start, setStart] = useState(initial.from);
  const [end, setEnd] = useState(initial.to);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

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

  async function download(slug: string, label: string) {
    if (!start || !end || end < start) {
      publishInlineMessage({ type: "WARNING", text: "Pick a valid date range first." });
      return;
    }
    const fn = `${slug}-${start}_${end}.csv`;
    setBusyKey(slug);
    try {
      await apiDownload(`/api/admin/exports/${slug}.csv?start=${start}&end=${end}`, fn);
      publishInlineMessage({ type: "SUCCESS", text: `${label} downloaded.` });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(`${label} download failed.`, err) });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <VStack align="stretch" gap={4} p={4} maxW="900px" mx="auto">
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
                  onChange={(e) => setStart(e.target.value)}
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
                  onChange={(e) => setEnd(e.target.value)}
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
                <Text color="fg.muted">QB Expenses (BusinessExpense):</Text>
                <Text>
                  {preview.qbExpenses.rows} row{preview.qbExpenses.rows === 1 ? "" : "s"}{" · "}
                  <b>${preview.qbExpenses.total.toFixed(2)}</b>
                </Text>
              </HStack>
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
          <Text fontSize="sm" fontWeight="medium" mb={2}>
            Gusto
          </Text>
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
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Body>
          <Text fontSize="sm" fontWeight="medium" mb={2}>
            QuickBooks
          </Text>
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
              onClick={() => download("qb-expenses", "QB Expenses CSV")}
            >
              <FiDownload /> Download Expenses CSV
            </Button>
          </VStack>
        </Card.Body>
      </Card.Root>

      <Box fontSize="xs" color="fg.muted" pl={1}>
        Each CSV ends with a <b>TOTALS</b> row. Compare against the Admin Money tab summary to
        verify before importing into Gusto/QuickBooks.
      </Box>
    </VStack>
  );
}
