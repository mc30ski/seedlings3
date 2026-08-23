"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Select,
  Spinner,
  Table,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Download, Eye, FileText, Info } from "lucide-react";
import { apiGet, apiDownload } from "@/src/lib/api";
import { bizAddDays, bizStartOfYear, bizToday, bizYearOf, fmtDateLong, type EtDateKey } from "@/src/lib/dates";
import DateInput from "@/src/ui/components/DateInput";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { downloadStatementPDF, getStatementBlob, type StatementData } from "@/src/lib/statement";
import { useLogoDataUrl } from "@/src/lib/useLogoDataUrl";

// Client-facing "Statements" tab.
//
// Lets a signed-in client generate a per-property payment statement
// for any date range they choose, downloadable as PDF or CSV. Blends
// with the rest of the client portal (Chakra components, existing
// tokens, same "My Properties / Community / Services" tab family).
//
// Super impersonation flows through automatically — the endpoint uses
// the same clientGuard that swaps in the impersonated Clerk ID.

type Property = { id: string; displayName: string };

type PortalMe = {
  linked: boolean;
  client?: { properties: Array<{ id: string; displayName: string }> };
};

// Named shortcuts for common date ranges. Each computes fresh at
// selection time so "This year to date" always means today, not
// whatever "today" was when the tab first loaded.
type Shortcut = {
  key: string;
  label: string;
  compute: () => { from: EtDateKey; to: EtDateKey };
};

const SHORTCUTS: Shortcut[] = [
  {
    key: "ytd",
    label: "This year to date",
    compute: () => ({ from: bizStartOfYear(), to: bizToday() }),
  },
  {
    key: "last_90",
    label: "Last 90 days",
    compute: () => ({ from: bizAddDays(bizToday(), -89), to: bizToday() }),
  },
  {
    key: "last_30",
    label: "Last 30 days",
    compute: () => ({ from: bizAddDays(bizToday(), -29), to: bizToday() }),
  },
  {
    key: "last_year",
    label: "Last calendar year",
    compute: () => {
      const currentYear = bizYearOf(bizStartOfYear());
      const from = `${currentYear - 1}-01-01` as EtDateKey;
      const to = `${currentYear - 1}-12-31` as EtDateKey;
      return { from, to };
    },
  },
  {
    key: "custom",
    label: "Custom range",
    compute: () => ({ from: bizToday(), to: bizToday() }),
  },
];

// Default landing shortcut — looked up by key (not position) so the
// order of SHORTCUTS can change without silently altering the default.
const DEFAULT_SHORTCUT = SHORTCUTS.find((s) => s.key === "ytd")!;

export default function ClientStatementsTab() {
  const logoDataUrl = useLogoDataUrl();
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState<string>("");
  const [shortcut, setShortcut] = useState<string>(DEFAULT_SHORTCUT.key);
  const [from, setFrom] = useState<EtDateKey>(DEFAULT_SHORTCUT.compute().from);
  const [to, setTo] = useState<EtDateKey>(DEFAULT_SHORTCUT.compute().to);
  const [data, setData] = useState<StatementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<"pdf" | "csv" | null>(null);

  // Load the client's properties on mount. Same endpoint the "My
  // Properties" tab uses; we get the union across every linked client.
  useEffect(() => {
    apiGet<PortalMe>("/api/client/me")
      .then((r) => {
        const list = r?.client?.properties ?? [];
        setProperties(list.map((p) => ({ id: p.id, displayName: p.displayName })));
        if (list.length > 0 && !propertyId) setPropertyId(list[0].id);
      })
      .catch((err) => {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Couldn't load your properties.", err),
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the operator picks a shortcut, re-derive from/to from the
  // shortcut's compute() at that moment. "Custom" just leaves the
  // current values in place so the operator can nudge them.
  function onShortcutChange(next: string) {
    setShortcut(next);
    if (next !== "custom") {
      const s = SHORTCUTS.find((s) => s.key === next);
      if (s) {
        const { from: f, to: t } = s.compute();
        setFrom(f);
        setTo(t);
      }
    }
  }

  // Load the JSON preview whenever the property / dates change. Keeps
  // the on-screen table in sync so the operator sees exactly what the
  // downloaded PDF/CSV will contain.
  const load = useCallback(async () => {
    if (!propertyId || !from || !to) return;
    if (from > to) return; // guard — UI shows a warning below
    setLoading(true);
    try {
      const qs = new URLSearchParams({ propertyId, from, to, format: "json" });
      const r = await apiGet<StatementData>(`/api/client/statement?${qs.toString()}`);
      setData(r);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't load the statement.", err),
      });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [propertyId, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const propertyCollection = useMemo(
    () =>
      createListCollection({
        items: properties.map((p) => ({ label: p.displayName, value: p.id })),
      }),
    [properties],
  );
  const shortcutCollection = useMemo(
    () =>
      createListCollection({
        items: SHORTCUTS.map((s) => ({ label: s.label, value: s.key })),
      }),
    [],
  );

  /** Merge the fetched logo data URL into the statement payload right
   *  before it's handed to the sync PDF generator. Kept in one spot so
   *  View + Download can't drift out of sync. */
  function withLogo(d: StatementData): StatementData {
    return { ...d, business: { ...d.business, logoDataUrl } };
  }

  function handleDownloadPDF() {
    if (!data) return;
    setDownloading("pdf");
    try {
      downloadStatementPDF(withLogo(data));
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't generate the PDF.", err),
      });
    } finally {
      setDownloading(null);
    }
  }

  /** Open the statement PDF inline in a new tab via a blob URL.
   *  Falls back to Download if the popup gets blocked. Mirrors the
   *  handleViewReceipt pattern from ClientMyJobsTab. */
  function handleViewPDF() {
    if (!data) return;
    try {
      const blob = getStatementBlob(withLogo(data));
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) {
        downloadStatementPDF(withLogo(data));
        publishInlineMessage({
          type: "INFO",
          text: "Your browser blocked the inline view, so we downloaded it instead.",
        });
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't open the statement.", err),
      });
    }
  }

  async function handleDownloadCSV() {
    if (!propertyId || !from || !to) return;
    setDownloading("csv");
    try {
      const qs = new URLSearchParams({ propertyId, from, to, format: "csv" });
      const propLabel = properties.find((p) => p.id === propertyId)?.displayName ?? "statement";
      const fname = `statement_${propLabel.replace(/[^a-zA-Z0-9]+/g, "-")}_${from}_to_${to}.csv`;
      await apiDownload(`/api/client/statement?${qs.toString()}`, fname);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't download the CSV.", err),
      });
    } finally {
      setDownloading(null);
    }
  }

  const rangeInvalid = !!from && !!to && from > to;
  const canDownload = !!data && !!propertyId && !rangeInvalid && !loading;

  return (
    <VStack align="stretch" gap={4} pb={6}>
      {/* "Statements" title removed — the tab pill above already labels
          this page; a second title read as redundant. Keep the descriptive
          subtitle so first-time visitors know what the page does. */}
      <Text fontSize="sm" color="fg.muted">
        Download a record of your payments for any date range. Useful for
        taxes, expense tracking, or your own records.
      </Text>

      {/* Compact one-liner — the full "what's on the statement" detail
          was accountant-thorough but ate the top of the page. Trimmed to
          the two facts that actually matter for a client scanning: cash
          basis (grouped by payment date), and unpaid amounts aren't
          included. Everything else is self-evident from the preview
          table below. */}
      <HStack
        gap={2}
        align="center"
        px={2.5}
        py={1.5}
        bg="blue.50"
        borderWidth="1px"
        borderColor="blue.200"
        borderRadius="md"
      >
        <Box color="blue.600" flexShrink={0}>
          <Info size={12} />
        </Box>
        <Text fontSize="xs" color="blue.900" lineHeight="1.3">
          Shows payments by the date we received them. Anything unpaid or skipped isn't included.
        </Text>
      </HStack>

      {/* Controls: property, shortcut, custom date range */}
      <Card.Root variant="outline">
        <Card.Body>
          <VStack align="stretch" gap={3}>
            <Box>
              <Text fontSize="xs" fontWeight="medium" mb={1}>
                Property
              </Text>
              <Select.Root
                collection={propertyCollection}
                value={propertyId ? [propertyId] : []}
                onValueChange={(e) => setPropertyId(e.value[0] ?? "")}
                size="sm"
                positioning={{ strategy: "fixed", hideWhenDetached: true }}
              >
                <Select.Control>
                  <Select.Trigger>
                    <Select.ValueText
                      placeholder={
                        properties.length === 0
                          ? "Loading properties…"
                          : "Choose a property…"
                      }
                    />
                    {/* Explicit chevron so the field reads as a dropdown,
                        not a text input. Chakra v3 doesn't render one by
                        default; without this the trigger looks identical
                        to a plain Input. */}
                    <Select.Indicator />
                  </Select.Trigger>
                </Select.Control>
                <Select.Positioner>
                  <Select.Content>
                    {propertyCollection.items.map((it) => (
                      <Select.Item key={it.value} item={it.value}>
                        <Select.ItemText>{it.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Select.Root>
            </Box>

            <Box>
              <Text fontSize="xs" fontWeight="medium" mb={1}>
                Date range
              </Text>
              <Select.Root
                collection={shortcutCollection}
                value={[shortcut]}
                onValueChange={(e) => onShortcutChange(e.value[0] ?? "custom")}
                size="sm"
                positioning={{ strategy: "fixed", hideWhenDetached: true }}
              >
                <Select.Control>
                  <Select.Trigger>
                    <Select.ValueText />
                    <Select.Indicator />
                  </Select.Trigger>
                </Select.Control>
                <Select.Positioner>
                  <Select.Content>
                    {shortcutCollection.items.map((it) => (
                      <Select.Item key={it.value} item={it.value}>
                        <Select.ItemText>{it.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Select.Root>
            </Box>

            <HStack gap={3} wrap="wrap">
              <Box flex="1" minW="140px">
                <Text fontSize="xs" fontWeight="medium" mb={1}>
                  From
                </Text>
                <HStack>
                  <DateInput
                    value={from}
                    disabled={shortcut !== "custom"}
                    onChange={(v) => setFrom(v)}
                  />
                </HStack>
              </Box>
              <Box flex="1" minW="140px">
                <Text fontSize="xs" fontWeight="medium" mb={1}>
                  To
                </Text>
                <HStack>
                  <DateInput
                    value={to}
                    disabled={shortcut !== "custom"}
                    onChange={(v) => setTo(v)}
                  />
                </HStack>
              </Box>
            </HStack>

            {rangeInvalid && (
              <Text fontSize="xs" color="red.600">
                "From" must be on or before "To".
              </Text>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* Preview — always in sync with the current inputs. What you see
          here is exactly what the PDF/CSV will contain. */}
      <Card.Root variant="outline">
        <Card.Body>
          <VStack align="stretch" gap={2}>
            <HStack justify="space-between" wrap="wrap" gap={2}>
              <VStack align="start" gap={0}>
                <Text fontSize="sm" fontWeight="semibold">
                  Preview
                </Text>
                {data && (
                  <Text fontSize="xs" color="fg.muted">
                    {fmtDateLong(data.period.from)} — {fmtDateLong(data.period.to)}
                    {" · "}
                    {data.rows.length} payment{data.rows.length === 1 ? "" : "s"}
                  </Text>
                )}
              </VStack>
              {data && (
                <Badge colorPalette="green" size="lg">
                  Total: ${data.total.toFixed(2)}
                </Badge>
              )}
            </HStack>

            {loading ? (
              <HStack justify="center" py={6}>
                <Spinner size="sm" />
                <Text fontSize="sm" color="fg.muted">
                  Loading…
                </Text>
              </HStack>
            ) : !data ? (
              <Text fontSize="sm" color="fg.muted" py={2}>
                Pick a property and date range to preview.
              </Text>
            ) : data.rows.length === 0 ? (
              <Text fontSize="sm" color="fg.muted" py={2}>
                No payments in this period for this property.
              </Text>
            ) : (
              <Box overflowX="auto">
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Receipt #</Table.ColumnHeader>
                      <Table.ColumnHeader>Service</Table.ColumnHeader>
                      <Table.ColumnHeader>Payment</Table.ColumnHeader>
                      <Table.ColumnHeader>Description</Table.ColumnHeader>
                      <Table.ColumnHeader>Method</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="right">Amount</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.rows.map((r, i) => (
                      <Table.Row key={i}>
                        <Table.Cell whiteSpace="nowrap" fontFamily="mono" fontSize="xs">
                          {r.receiptId}
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{r.serviceDate}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{r.paymentDate}</Table.Cell>
                        <Table.Cell>{r.description}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{r.method}</Table.Cell>
                        <Table.Cell textAlign="right" whiteSpace="nowrap">
                          ${r.amount.toFixed(2)}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            )}
          </VStack>
        </Card.Body>
      </Card.Root>

      {/* View / Download row — shortened labels + tighter padding so all
          three fit on one line at typical mobile widths. On very narrow
          viewports they wrap left-aligned as a group rather than the
          previous right-justified stagger. */}
      <HStack gap={2} justify="flex-end" wrap="wrap" rowGap={2}>
        <Button
          size="sm"
          variant="outline"
          colorPalette="blue"
          px="3"
          disabled={!canDownload}
          onClick={handleViewPDF}
          title="Open the statement PDF in a new tab"
        >
          <Eye size={14} /> View
        </Button>
        <Button
          size="sm"
          colorPalette="blue"
          px="3"
          disabled={!canDownload}
          loading={downloading === "pdf"}
          onClick={handleDownloadPDF}
          title="Download the statement as a PDF"
        >
          <Download size={14} /> PDF
        </Button>
        <Button
          size="sm"
          variant="outline"
          colorPalette="blue"
          px="3"
          disabled={!canDownload}
          loading={downloading === "csv"}
          onClick={() => void handleDownloadCSV()}
          title="Download the statement as a CSV"
        >
          <Download size={14} /> CSV
        </Button>
      </HStack>
    </VStack>
  );
}
