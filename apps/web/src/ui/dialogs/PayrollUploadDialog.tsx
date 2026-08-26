"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PayrollUploadDialog — Super-only import of a Gusto Payroll Journal CSV.
//
// Canonical spec: docs/features/payroll.md.
//
// The file is read in the browser and POSTed as text; the server stores the
// original in R2 and parses it. The server is also where validation lives —
// this dialog's job is to make a REJECTION legible, because the two ways an
// import fails are both things the operator can act on:
//
//   PAYROLL_DOES_NOT_BALANCE : the rows don't sum to Gusto's own totals row.
//                              Names the offending column and both numbers.
//   PAYROLL_UNREADABLE       : it isn't a Payroll Journal export.
//
// Re-uploading a period REPLACES it. That is the only edit path, so the
// dialog says so before the operator commits.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";
import { Badge, Box, Button, Dialog, HStack, Portal, Text, VStack } from "@chakra-ui/react";
import { FiUpload, FiFileText } from "react-icons/fi";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import { fmtDateKey } from "@/src/lib/dates";
import { importPayrollCsv, type ImportedPeriod } from "@/src/lib/payroll";

type Mismatch = {
  field: string;
  header: string;
  summed: number;
  reported: number;
  difference: number;
};

export default function PayrollUploadDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (periods: ImportedPeriod[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatches, setMismatches] = useState<Mismatch[]>([]);
  const [result, setResult] = useState<ImportedPeriod[] | null>(null);

  function reset() {
    setFilename(null);
    setCsvText(null);
    setError(null);
    setMismatches([]);
    setResult(null);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function pick(file: File | null) {
    setError(null);
    setMismatches([]);
    setResult(null);
    if (!file) return;
    setFilename(file.name);
    setCsvText(await file.text());
  }

  async function submit() {
    if (!csvText) return;
    setBusy(true);
    setError(null);
    setMismatches([]);
    try {
      const res = await importPayrollCsv(csvText, filename ?? "payroll.csv");
      setResult(res.periods);
      const replaced = res.periods.filter((p) => p.replaced);
      const unchanged = replaced.filter((p) => !p.changed).length;
      publishInlineMessage({
        type: "SUCCESS",
        text:
          // "Replaced" alone reads as "something changed". When the same
          // export is re-imported nothing moves, and saying so is the
          // difference between a confusing no-op and a clear one.
          unchanged > 0 && unchanged === replaced.length
            ? `Already imported — the figures are unchanged.`
            : replaced.length > 0
              ? `Imported ${res.periods.length} period(s); ${replaced.length} replaced an existing one.`
              : `Imported ${res.periods.length} pay period(s).`,
      });
      onImported(res.periods);
    } catch (err: any) {
      // The server returns a structured 422 for both refusal modes; surface
      // the detail rather than a generic failure, since the operator has to
      // go back to Gusto with it.
      const body = err?.body ?? err?.data ?? null;
      if (body?.error === "PAYROLL_DOES_NOT_BALANCE") {
        setError(body.message);
        setMismatches(Array.isArray(body.mismatches) ? body.mismatches : []);
      } else if (body?.error === "PAYROLL_UNREADABLE") {
        setError(body.message);
      } else {
        setError(err?.message || "Import failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) {
          reset();
          onClose();
        }
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            maxW="md"
            mx={{ base: "3", md: "4" }}
            w="full"
            minW={0}
            rounded="2xl"
            p="4"
            shadow="lg"
          >
            <Dialog.Header>
              <Dialog.Title>Upload payroll</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">
                  Choose the <strong>Payroll Journal</strong> CSV exported from Gusto. The pay
                  period and pay day are read from the file.
                </Text>

                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                />
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <FiFileText /> {filename ? "Choose a different file" : "Choose CSV file"}
                </Button>
                {filename && (
                  <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                    {filename}
                  </Text>
                )}

                <Box
                  p={2}
                  bg="orange.50"
                  borderWidth="1px"
                  borderColor="orange.200"
                  rounded="md"
                >
                  <Text fontSize="xs" color="orange.900">
                    Uploading a period that already exists <strong>replaces</strong> it. The
                    previous figures are written to the audit log first, and the original file
                    is kept.
                  </Text>
                </Box>

                {error && (
                  <Box p={3} bg="red.50" borderWidth="1px" borderColor="red.300" rounded="md">
                    <Text fontSize="sm" fontWeight="semibold" color="red.800">
                      Import refused
                    </Text>
                    <Text fontSize="xs" color="red.900" mt={1}>
                      {error}
                    </Text>
                    {mismatches.length > 0 && (
                      <VStack align="stretch" gap={1} mt={2}>
                        {mismatches.map((m) => (
                          <HStack key={m.field} justify="space-between" gap={2}>
                            <Text fontSize="2xs" color="red.900" lineClamp={1}>
                              {m.header}
                            </Text>
                            <Text
                              fontSize="2xs"
                              color="red.900"
                              fontVariantNumeric="tabular-nums"
                              flexShrink={0}
                            >
                              rows {m.summed.toFixed(2)} vs totals {m.reported.toFixed(2)}
                            </Text>
                          </HStack>
                        ))}
                      </VStack>
                    )}
                    <Text fontSize="2xs" color="red.700" mt={2}>
                      Nothing was imported. Re-export from Gusto without editing the file.
                    </Text>
                  </Box>
                )}

                {result && result.length > 0 && (
                  <Box p={3} bg="green.50" borderWidth="1px" borderColor="green.300" rounded="md">
                    <Text fontSize="sm" fontWeight="semibold" color="green.800">
                      Imported
                    </Text>
                    <VStack align="stretch" gap={1} mt={1}>
                      {result.map((p) => (
                        <HStack key={p.periodId} justify="space-between" gap={2} wrap="wrap">
                          <Text fontSize="xs" color="green.900">
                            {fmtDateKey(p.periodStart)} – {fmtDateKey(p.periodEnd)} · paid{" "}
                            {fmtDateKey(p.payDay)}
                          </Text>
                          <HStack gap={1} flexShrink={0}>
                            {p.replaced && (
                              <Badge
                                size="sm"
                                colorPalette={p.changed ? "orange" : "gray"}
                                variant="subtle"
                              >
                                {p.changed ? "replaced" : "no change"}
                              </Badge>
                            )}
                            {p.unmatched.length > 0 && (
                              <Badge size="sm" colorPalette="orange" variant="solid">
                                {p.unmatched.length} to match
                              </Badge>
                            )}
                          </HStack>
                        </HStack>
                      ))}
                    </VStack>
                    {result.some((p) => p.unmatched.length > 0) && (
                      <Text fontSize="2xs" color="green.800" mt={2}>
                        Names that aren&apos;t linked to an app user yet are listed on the
                        Payroll tab. Workers can&apos;t see their pay until you confirm who they
                        are.
                      </Text>
                    )}
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    reset();
                    onClose();
                  }}
                >
                  {result ? "Done" : "Cancel"}
                </Button>
                <Button
                  size="sm"
                  colorPalette="green"
                  loading={busy}
                  disabled={!csvText || !!result}
                  onClick={() => void submit()}
                >
                  <FiUpload /> Import
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
