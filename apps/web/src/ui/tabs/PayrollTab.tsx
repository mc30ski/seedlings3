"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PayrollTab — Money → Payroll, blended across Worker / Admin / Super.
//
// Canonical spec: docs/features/payroll.md.
//
// WHAT EACH ROLE SEES (decided server-side; this file only renders what it
// is given — see apps/api/src/services/payroll.ts):
//   Worker : own rows, full breakdown including every tax line
//   Admin  : any worker, hours / gross / net ONLY
//   Super  : any worker, full breakdown, plus unmatched rows and mutations
//
// This component NEVER hides a field it received. If a tax figure is absent
// from an admin's payload that is the server withholding it, and the empty
// space is the correct rendering. Do not "helpfully" fetch more.
//
// Payroll is what Gusto PAID. It is not the app's estimate — the
// "My earnings" card is a different number and says so.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Select,
  Separator,
  SimpleGrid,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { FiUpload, FiChevronRight, FiAlertTriangle, FiArchive, FiInfo } from "react-icons/fi";
// Banknote matches the Home PAYROLL section and the tab's own menu
// icon; the dollar glyph is already the Money category + Payments tab.
import { Banknote } from "lucide-react";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { determineRoles } from "@/src/lib/roles";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { fmtDateKey } from "@/src/lib/dates";
import type { Me, Role } from "@/src/lib/types";
import {
  fetchMyPayrollPeriods,
  fetchMyPayrollPeriod,
  fetchPayrollPendingMatch,
  fetchPayrollPeriods,
  fetchPayrollEntries,
  archivePayrollPeriod,
  fmtPayrollMoney,
  fmtPayrollHours,
  filterPeriodsByRange,
  sumMine,
  sumTeam,
  PAYROLL_RANGES,
  type PayrollRangeKey,
  type PayrollPeriodSummary,
  type PayrollPeriodDetail,
  type PayrollEntryView,
} from "@/src/lib/payroll";
import PayrollUploadDialog from "@/src/ui/dialogs/PayrollUploadDialog";
import PayrollIdentityReview from "@/src/ui/components/PayrollIdentityReview";

type Props = {
  me: Me | null;
  purpose?: Role;
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
  /** Admin/Super: narrow the operator view to one worker. */
  viewAsUserId?: string | null;
  viewAsDisplayName?: string | null;
};

export default function PayrollTab({
  me,
  purpose = "WORKER",
  scope,
  viewAsUserId,
  viewAsDisplayName,
}: Props) {
  const { isSuper: hasSuperRole } = determineRoles(me, purpose);

  const effScope = scope ?? {
    isWorker: purpose === "WORKER",
    isAdmin: purpose === "ADMIN" || purpose === "SUPER",
    isSuper: purpose === "SUPER",
  };
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  // NOT `|| forAdmin` — a super-role user viewing the ADMIN tab must not
  // get Super controls. See reference_tab_blend_pattern.
  const showSuperExtras = effScope.isSuper && hasSuperRole;

  const [periods, setPeriods] = useState<PayrollPeriodSummary[]>([]);
  // `loaded` (not `loading`) gates the full-tab spinner. A refresh must not
  // blank the tree: the upload dialog is a child, so unmounting on every
  // reload tore it down mid-flow and it remounted with its file selection
  // and import summary gone. Only the FIRST load shows the spinner.
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PayrollPeriodDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [archiveFor, setArchiveFor] = useState<PayrollPeriodSummary | null>(null);
  const [reviewNonce, setReviewNonce] = useState(0);
  // Worker-side counterpart to the Super's identity queue: tells a worker
  // that a period may be theirs and is waiting to be matched. Without it a
  // name change makes a pay period vanish silently.
  const [pending, setPending] = useState<{ affected: boolean; payDay: string | null }>({
    affected: false,
    payDay: null,
  });
  // Timeframe filter. Periods are whatever was uploaded and the cadence can
  // change, so this filters BY PAY DAY rather than assuming a week length.
  // Defaults to "all" here (unlike Home, which defaults to the latest) —
  // this is the tab you open to go back through history.
  const [range, setRange] = usePersistedState<PayrollRangeKey>(
    showAdminExtras ? "payrollTab_rangeAdmin" : "payrollTab_range",
    "all",
  );

  const load = useCallback(async () => {
    try {
      if (showAdminExtras) {
        setPeriods(await fetchPayrollPeriods());
      } else {
        const [rows, notice] = await Promise.all([
          fetchMyPayrollPeriods(),
          fetchPayrollPendingMatch().catch(() => ({ affected: false, payDay: null })),
        ]);
        setPeriods(rows);
        setPending(notice);
      }
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't load payroll.", err),
      });
      setPeriods([]);
    } finally {
      setLoaded(true);
    }
  }, [showAdminExtras]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPeriod = useCallback(
    async (id: string) => {
      if (openId === id) {
        setOpenId(null);
        setDetail(null);
        return;
      }
      setOpenId(id);
      setDetail(null);
      setDetailLoading(true);
      try {
        setDetail(
          showAdminExtras
            ? await fetchPayrollEntries(id, viewAsUserId ?? null)
            : await fetchMyPayrollPeriod(id),
        );
      } catch (err) {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Couldn't load that pay period.", err),
        });
        setOpenId(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [openId, showAdminExtras, viewAsUserId],
  );

  const shown = useMemo(() => filterPeriodsByRange(periods, range), [periods, range]);
  // Totals across the visible window, so the header answers "what did this
  // timeframe cost / earn" without opening every period.
  const rangeTotals = useMemo(
    () => (showAdminExtras ? sumTeam(shown) : sumMine(shown)),
    [shown, showAdminExtras],
  );

  const totalUnmatched = useMemo(
    () => periods.reduce((a, p) => a + (p.unmatchedCount ?? 0), 0),
    [periods],
  );

  const rangeCollection = createListCollection({
    items: PAYROLL_RANGES.map((r) => ({ label: r.label, value: r.key })),
  });

  if (!loaded) {
    return (
      <Box py={10} textAlign="center">
        <Spinner size="lg" />
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={3}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <HStack justify="space-between" align="center" wrap="wrap" gap={2}>
        <VStack align="start" gap={0} minW={0}>
          <HStack gap={2}>
            <Banknote size={16} />
            <Text fontSize="md" fontWeight="bold">
              Payroll
            </Text>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            {showAdminExtras
              ? "What Gusto paid, per pay period."
              // The Gusto attribution below carries the provenance now, so
              // repeating it here was redundant.
              : "What you were actually paid."}
          </Text>
          {/* Attribution for the system of record. Every figure on this tab
              came out of a Gusto export — this app never computes pay — so
              naming the source is the honest framing, not decoration.
              See docs/features/payroll.md.

              TEXT ONLY, deliberately: the official mark should come from
              Gusto's own brand kit rather than a third-party logo
              aggregator, whose copies go stale and aren't licensed to
              redistribute. Drop the real asset in and swap the Box below
              for an <img>. */}
          <HStack gap={1.5} mt={1} align="center">
            <Box
              px={1.5}
              py={0.5}
              rounded="sm"
              bg="orange.100"
              color="orange.800"
              fontSize="2xs"
              fontWeight="bold"
              letterSpacing="wide"
              flexShrink={0}
            >
              gusto
            </Box>
            <Text fontSize="2xs" color="fg.muted">
              Powered by Gusto · source of record for pay
            </Text>
          </HStack>
        </VStack>
        {showSuperExtras && (
          <Button size="sm" colorPalette="green" onClick={() => setUploadOpen(true)}>
            <FiUpload /> Upload payroll
          </Button>
        )}
      </HStack>

      {/* Estimates vs actuals — stated plainly rather than left for a
          worker to discover as an apparent discrepancy.

          Given slightly more weight than a footnote: this is the one thing
          that stops a worker reading two different numbers for their own
          pay as a bug. An icon, a bold lead, sm text and a left accent —
          still informational blue, not a warning. */}
      {!showAdminExtras && (
        <Box
          p={3}
          bg="blue.50"
          borderWidth="1px"
          borderColor="blue.300"
          borderLeftWidth="4px"
          borderLeftColor="blue.400"
          rounded="md"
        >
          <HStack gap={2} align="start">
            <Box color="blue.600" flexShrink={0} mt="1px">
              <FiInfo />
            </Box>
            <Text fontSize="sm" color="blue.900" lineHeight="1.45">
              <Text as="span" fontWeight="bold">
                These are actual amounts paid.
              </Text>{" "}
              The &quot;My earnings&quot; figure on your Home tab is an estimate from job
              values and does not include taxes — the two will not match.
            </Text>
          </HStack>
        </Box>
      )}

      {/* Worker-facing pending-match notice. The Super sees the same
          situation as a review queue below; this is the worker's half. */}
      {!showAdminExtras && pending.affected && (
        <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" rounded="md">
          <Text fontSize="xs" color="orange.900">
            A pay period{pending.payDay ? ` from ${fmtDateKey(pending.payDay)}` : ""} hasn&apos;t
            been matched to an account yet. If it&apos;s yours, ask your admin to match it —
            payroll is matched by name, so a name change can leave it unlinked.
          </Text>
        </Box>
      )}

      {/* ── Identity review (Super) ────────────────────────────────────── */}
      {showSuperExtras && totalUnmatched > 0 && (
        <PayrollIdentityReview
          key={reviewNonce}
          onChanged={() => {
            setReviewNonce((n) => n + 1);
            void load();
            if (openId) void openPeriod(openId);
          }}
        />
      )}

      {/* ── Timeframe ──────────────────────────────────────────────────── */}
      {periods.length > 0 && (
        <HStack gap={2} wrap="wrap" align="center">
          {/* Sized to content, matching the Home section's picker. */}
          <Box flexShrink={0}>
            <Select.Root
              collection={rangeCollection}
              value={[range]}
              onValueChange={(e) => {
                const v = e.value?.[0] as PayrollRangeKey | undefined;
                if (v) setRange(v);
              }}
              size="sm"
              positioning={{ strategy: "fixed", hideWhenDetached: true }}
            >
              <Select.Control>
                <Select.Trigger w="auto" minW="180px" px="2">
                  <Select.ValueText placeholder="Timeframe" />
                  <Select.Indicator />
                </Select.Trigger>
              </Select.Control>
              <Select.Positioner>
                <Select.Content minW="var(--reference-width)">
                  {rangeCollection.items.map((item) => (
                    <Select.Item key={item.value} item={item.value}>
                      <Select.ItemText>{item.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Select.Root>
          </Box>
          {shown.length > 0 && (
            <HStack gap={3} flexShrink={0}>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
                  {showAdminExtras ? "Team net" : "Net"}
                </Text>
                <Text fontSize="sm" fontWeight="bold" color="green.700" fontVariantNumeric="tabular-nums">
                  {fmtPayrollMoney(rangeTotals.netPay)}
                </Text>
              </VStack>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
                  Gross
                </Text>
                <Text fontSize="sm" fontWeight="bold" fontVariantNumeric="tabular-nums">
                  {fmtPayrollMoney(rangeTotals.grossEarnings)}
                </Text>
              </VStack>
              <Text fontSize="2xs" color="fg.muted">
                {shown.length} of {periods.length}
              </Text>
            </HStack>
          )}
        </HStack>
      )}

      {/* ── Periods ────────────────────────────────────────────────────── */}
      {periods.length === 0 ? (
        <Card.Root variant="outline">
          <Card.Body p={6} textAlign="center">
            <Text fontSize="sm" fontWeight="medium">
              {showAdminExtras ? "No payroll imported yet" : "No payroll records for you yet"}
            </Text>
            <Text fontSize="xs" color="fg.muted" mt={1}>
              {showAdminExtras
                ? "Upload a Gusto Payroll Journal export to get started."
                : // Same reasoning as PayrollHomeSection: an unmatched row
                  // is indistinguishable from "nothing imported" at this
                  // end, so don't claim a cause. Naming how matching works
                  // is what actually helps them get it resolved.
                  "If you're expecting pay here, check with your admin — payroll is matched to your account by name."}
            </Text>
          </Card.Body>
        </Card.Root>
      ) : (
        <VStack align="stretch" gap={2}>
          {shown.length === 0 && (
            <Card.Root variant="outline">
              <Card.Body p={4} textAlign="center">
                <Text fontSize="sm">Nothing in this timeframe</Text>
                <Text fontSize="xs" color="fg.muted" mt={1}>
                  {periods.length} earlier {periods.length === 1 ? "period is" : "periods are"} on
                  record — widen the timeframe to see them.
                </Text>
              </Card.Body>
            </Card.Root>
          )}
          {shown.map((p) => {
            const isOpen = openId === p.id;
            return (
              <Card.Root key={p.id} variant="outline" borderColor={isOpen ? "green.300" : undefined}>
                <Card.Body p={3}>
                  <HStack
                    justify="space-between"
                    align="center"
                    gap={3}
                    cursor="pointer"
                    onClick={() => void openPeriod(p.id)}
                  >
                    <VStack align="start" gap={0} flex={1} minW={0}>
                      <HStack gap={2} wrap="wrap">
                        <Text fontSize="sm" fontWeight="semibold">
                          Paid {fmtDateKey(p.payDay)}
                        </Text>
                        {p.label && (
                          <Badge size="sm" colorPalette="gray" variant="subtle">
                            {p.label}
                          </Badge>
                        )}
                        {showSuperExtras && (p.unmatchedCount ?? 0) > 0 && (
                          <Badge size="sm" colorPalette="orange" variant="solid">
                            {p.unmatchedCount} unmatched
                          </Badge>
                        )}
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDateKey(p.periodStart)} – {fmtDateKey(p.periodEnd)}
                        {p.entryCount != null ? ` · ${p.entryCount} on payroll` : ""}
                      </Text>
                    </VStack>

                    <VStack align="end" gap={0} flexShrink={0}>
                      {p.mine && (
                        <>
                          <Text fontSize="sm" fontWeight="bold" color="green.700">
                            {fmtPayrollMoney(p.mine.netPay)}
                          </Text>
                          <Text fontSize="2xs" color="fg.muted">
                            net
                          </Text>
                        </>
                      )}
                      {p.teamTotals && (
                        <>
                          <Text fontSize="sm" fontWeight="bold" color="green.700">
                            {fmtPayrollMoney(p.teamTotals.netPay)}
                          </Text>
                          <Text fontSize="2xs" color="fg.muted">
                            team net
                          </Text>
                        </>
                      )}
                    </VStack>
                    <Box color="fg.muted" flexShrink={0}>
                      <FiChevronRight
                        style={{ transform: isOpen ? "rotate(90deg)" : undefined }}
                      />
                    </Box>
                  </HStack>

                  {isOpen && (
                    <>
                      <Separator my={3} />
                      {detailLoading ? (
                        <Box py={4} textAlign="center">
                          <Spinner size="sm" />
                        </Box>
                      ) : (
                        <PeriodDetail
                          detail={detail}
                          showAdminExtras={showAdminExtras}
                          viewAsDisplayName={viewAsDisplayName ?? null}
                        />
                      )}
                      {showSuperExtras && (
                        <HStack justify="flex-end" mt={3}>
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="red"
                            onClick={() => setArchiveFor(p)}
                          >
                            <FiArchive /> Archive period
                          </Button>
                        </HStack>
                      )}
                    </>
                  )}
                </Card.Body>
              </Card.Root>
            );
          })}
        </VStack>
      )}

      {showSuperExtras && (
        <PayrollUploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          // Refresh behind the dialog but DO NOT close it. The dialog shows
          // what was imported — which periods, which replaced an existing
          // one, how many names still need matching. Closing on success
          // would make that summary unreachable, and the unmatched count is
          // the one number the operator has to act on next.
          onImported={() => {
            setOpenId(null);
            void load();
            // Remount the identity queue too. `load()` refreshes the period
            // list (so the "N unmatched" badge updates), but the review
            // component fetches its own names on mount — without this the
            // operator sees a period flagged unmatched while the queue
            // above it still shows the pre-import state.
            setReviewNonce((n) => n + 1);
          }}
        />
      )}

      {/* Mandatory confirm on a destructive action. */}
      <ConfirmDialog
        open={!!archiveFor}
        title="Archive this pay period?"
        message={
          archiveFor
            ? `Workers will no longer see the period paid ${fmtDateKey(archiveFor.payDay)}. ` +
              `The record and the original CSV are kept, and the full contents are written to the audit log first.`
            : ""
        }
        confirmLabel="Archive"
        confirmColorPalette="red"
        onCancel={() => setArchiveFor(null)}
        onConfirm={async () => {
          const target = archiveFor;
          setArchiveFor(null);
          if (!target) return;
          try {
            await archivePayrollPeriod(target.id);
            publishInlineMessage({ type: "SUCCESS", text: "Pay period archived." });
            setOpenId(null);
            void load();
          } catch (err) {
            publishInlineMessage({
              type: "ERROR",
              text: getErrorMessage("Couldn't archive that period.", err),
            });
          }
        }}
      />
    </VStack>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function PeriodDetail({
  detail,
  showAdminExtras,
  viewAsDisplayName,
}: {
  detail: PayrollPeriodDetail | null;
  showAdminExtras: boolean;
  viewAsDisplayName: string | null;
}) {
  if (!detail) return null;
  if (detail.entries.length === 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        {viewAsDisplayName
          ? `${viewAsDisplayName} has no row in this period.`
          : "No rows in this period."}
      </Text>
    );
  }

  return (
    <VStack align="stretch" gap={3}>
      {detail.entries.map((e) => (
        <EntryRow key={e.id} entry={e} showAdminExtras={showAdminExtras} />
      ))}
    </VStack>
  );
}

function EntryRow({
  entry,
  showAdminExtras,
}: {
  entry: PayrollEntryView;
  showAdminExtras: boolean;
}) {
  const v = entry.values;
  // Present only when the server sent them. An admin payload genuinely has
  // no tax fields — the absence IS the access control, so this is a
  // presence check, not a role check.
  const hasTaxDetail = "federalIncomeTax" in v || "employeeTaxes" in v;

  return (
    <Box borderWidth="1px" borderColor="gray.200" rounded="md" p={3}>
      <HStack justify="space-between" align="start" gap={2} mb={2}>
        <VStack align="start" gap={0} minW={0}>
          <Text fontSize="sm" fontWeight="semibold">
            {entry.displayName ?? `${entry.rawFirstName} ${entry.rawLastName}`}
          </Text>
          {entry.employeeType && (
            <Text fontSize="2xs" color="fg.muted">
              {entry.employeeType}
              {entry.paymentMethod ? ` · ${entry.paymentMethod}` : ""}
            </Text>
          )}
        </VStack>
        {entry.unmatched && (
          <Badge size="sm" colorPalette="orange" variant="solid" flexShrink={0}>
            <FiAlertTriangle /> Unmatched
          </Badge>
        )}
      </HStack>

      <SimpleGrid columns={{ base: 2, md: 4 }} gap={2}>
        <Figure label="Hours" value={fmtPayrollHours(v.regularHours)} />
        <Figure label="Gross" value={fmtPayrollMoney(v.grossEarnings)} />
        <Figure label="Net pay" value={fmtPayrollMoney(v.netPay)} emphasis />
        <Figure label="Check" value={fmtPayrollMoney(v.checkAmount)} />
      </SimpleGrid>

      {hasTaxDetail && (
        <>
          <Separator my={3} />
          <Text fontSize="2xs" fontWeight="bold" color="fg.muted" mb={1} letterSpacing="wide">
            WITHHELD
          </Text>
          <SimpleGrid columns={{ base: 2, md: 3 }} gap={2}>
            <Figure label="Federal income tax" value={fmtPayrollMoney(v.federalIncomeTax)} />
            <Figure label="State tax" value={fmtPayrollMoney(v.stateTaxEmployee)} />
            <Figure label="Social Security" value={fmtPayrollMoney(v.socialSecurityEmployee)} />
            <Figure label="Medicare" value={fmtPayrollMoney(v.medicareEmployee)} />
            <Figure label="Addl. Medicare" value={fmtPayrollMoney(v.additionalMedicareEmployee)} />
            <Figure label="Total withheld" value={fmtPayrollMoney(v.employeeTaxes)} />
          </SimpleGrid>

          {!showAdminExtras && (v.reimbursements != null || v.donations != null) && (
            <SimpleGrid columns={{ base: 2, md: 3 }} gap={2} mt={2}>
              <Figure label="Reimbursements" value={fmtPayrollMoney(v.reimbursements)} />
              <Figure label="Donations" value={fmtPayrollMoney(v.donations)} />
            </SimpleGrid>
          )}
        </>
      )}
    </Box>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <VStack align="start" gap={0} minW={0}>
      <Text fontSize="2xs" color="fg.muted" lineClamp={1}>
        {label}
      </Text>
      <Text
        fontSize={emphasis ? "sm" : "xs"}
        fontWeight={emphasis ? "bold" : "medium"}
        color={emphasis ? "green.700" : undefined}
        fontVariantNumeric="tabular-nums"
      >
        {value}
      </Text>
    </VStack>
  );
}
