"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PayrollHomeSection — the MY PAYDAY section on the Home tab.
//
// Canonical spec: docs/features/payroll.md.
//
// A summary of what the worker was ACTUALLY paid, over a timeframe they
// choose. Sits next to the "Approximate pay per hour" card ON PURPOSE:
// those two numbers disagree — one is the app's estimate from job values,
// the other is Gusto's after-tax reality. Separating them doesn't remove
// the discrepancy, it just makes it look like a bug when a worker
// eventually notices. So they sit together and each says what it is.
//
// TIMEFRAME, NOT "THIS WEEK". Pay cadence can change, so the UI never
// assumes one. The picker filters the periods ON RECORD by PAY DAY — the
// date a worker recognises as "when the money arrived".
//
// NO "NEXT PAY DAY". Uploads are manual and sequential, so a predicted
// date would be inferred from history and wrong the first time a schedule
// changes. Deliberately absent — do not add it.
//
// The section renders even with NOTHING on record. An invisible section is
// indistinguishable from a missing feature, which is exactly how this was
// first reported.
//
// PALETTE: the blue `info` Dashboard variant. Green reads as "good
// result" — payroll is a statement of fact about what was paid, not a
// verdict on it. Blue also keeps it distinct from the neutral-gray
// approximate-pay card directly above.
//
// The content sits DIRECTLY in the frame. An inner tinted card would be
// a section inside a section — the frame IS the section.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  HStack,
  Select,
  SimpleGrid,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
// Dashboard types `icon` as a LucideIcon, so this must come from
// lucide-react — the react-icons TfiMoney used on the Payroll tab is a
// different, incompatible component type.
import { Banknote } from "lucide-react";
import { Dashboard } from "@/src/ui/components/Dashboard";
import { SkeletonBanner } from "@/src/ui/tabs/JobsTab.parts";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { fmtDateKey } from "@/src/lib/dates";
import {
  fetchMyPayrollPeriods,
  fetchPayrollPendingMatch,
  fmtPayrollMoney,
  filterPeriodsByRange,
  sumMine,
  PAYROLL_RANGES,
  type PayrollRangeKey,
  type PayrollPeriodSummary,
} from "@/src/lib/payroll";

export default function PayrollHomeSection({
  viewAsUserId,
  viewAsDisplayName,
  storageKey = "seedlings:homeTab:payrollOpen",
}: {
  /** Set when an admin is viewing a single worker. Server-gated. */
  viewAsUserId?: string | null;
  viewAsDisplayName?: string | null;
  storageKey?: string;
}) {
  const [periods, setPeriods] = useState<PayrollPeriodSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  // "A period of yours may be sitting unmatched." Without this a name
  // change makes a whole pay period vanish with no cue at all.
  const [pending, setPending] = useState<{ affected: boolean; payDay: string | null }>({
    affected: false,
    payDay: null,
  });
  const [range, setRange] = usePersistedState<PayrollRangeKey>(
    "homeTab_payrollRange",
    "latest",
  );

  const load = useCallback(async () => {
    try {
      const [rows, notice] = await Promise.all([
        fetchMyPayrollPeriods({ viewAsUserId: viewAsUserId ?? null }),
        fetchPayrollPendingMatch({ viewAsUserId: viewAsUserId ?? null }).catch(() => ({
          affected: false,
          payDay: null,
        })),
      ]);
      setPeriods(Array.isArray(rows) ? rows : []);
      setPending(notice);
    } catch {
      // A payroll fetch failing must not break Home. The tab itself is the
      // place to diagnose it.
      setPeriods([]);
    } finally {
      setLoaded(true);
    }
  }, [viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => filterPeriodsByRange(periods, range), [periods, range]);
  const totals = useMemo(() => sumMine(shown), [shown]);
  const newest = shown[0] ?? null;

  const rangeCollection = createListCollection({
    items: PAYROLL_RANGES.map((r) => ({ label: r.label, value: r.key })),
  });

  const isViewingOther = !!viewAsUserId;
  // "My payday" for the worker's own section; "Payday: Name" when an admin
  // is viewing someone else, since "My" would then be wrong. Same shape as
  // MY ACTIVITIES / MY EARNINGS, and the colon convention every Home
  // section shares.
  //
  // The TAB is still called Payroll (Money → Payroll) — that surface is
  // also the operator's team view, where "My payday" would be nonsense.
  const title =
    isViewingOther && viewAsDisplayName ? `Payday: ${viewAsDisplayName}` : "My payday";

  if (!loaded) return <SkeletonBanner label="payroll" />;

  return (
    <Dashboard storageKey={storageKey} title={title} icon={Banknote} variant="info">
      <VStack align="stretch" gap={2}>
        {pending.affected && (
          <Box
            borderWidth="1px"
            borderColor="orange.300"
            bg="orange.50"
            rounded="md"
            px={2}
            py={1.5}
          >
            <Text fontSize="xs" color="orange.900">
              A pay period{pending.payDay ? ` from ${fmtDateKey(pending.payDay)}` : ""} hasn&apos;t
              been matched to an account yet. If it&apos;s yours, ask your admin to match it —
              payroll is matched by name, so a name change can leave it unlinked.
            </Text>
          </Box>
        )}
        {/* Picker and "View all" grouped on the RIGHT — they are both
            controls, and splitting them to opposite edges made the row read
            as two unrelated things. */}
        <HStack justify="flex-end" gap={2} wrap="wrap" align="center">
          {/* Sized to its longest option rather than stretched. A
              full-width trigger made the menu a narrow box under a very
              wide control, and on flip-up it covered the card above.
              Same treatment as the ReconcileTab pickers. */}
          {/* No periods at all = nothing to filter. Hiding the picker here
              matches PayrollTab, and stops it being a permanently dead
              control for anyone never on payroll — the LLC owner takes
              draws rather than wages, so this is their steady state. */}
          {periods.length > 0 && (
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
          )}
          <Button
            size="xs"
            variant="outline"
            colorPalette="blue"
            flexShrink={0}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("navigate:workerTab", { detail: { tab: "payroll" } }),
              )
            }
          >
            View all
          </Button>
        </HStack>

        {shown.length === 0 ? (
          // Rendered, not hidden. A worker who has never been on a Gusto
          // payroll run (every contractor today) still gets told why this
          // is empty instead of wondering whether the feature exists.
          <Box>
            <Text fontSize="sm" fontWeight="medium" color="blue.900">
              {periods.length === 0
                ? "No payroll records yet"
                : "Nothing in this timeframe"}
            </Text>
            <Text fontSize="xs" color="blue.800" mt={1}>
              {periods.length === 0
                ? // Deliberately does NOT explain WHY it's empty. The two
                  // obvious reasons look identical from here: nothing has
                  // been imported, OR a row exists but its name hasn't been
                  // matched to this account yet (see the Super identity
                  // queue). The old copy asserted "once they've been
                  // imported… contractors aren't included", both of which
                  // are false for an unmatched W-2 employee whose pay is
                  // sitting in that queue. Point at the remedy instead.
                  "If you're expecting pay here, check with your admin — payroll is matched to your account by name."
                : "Try a wider timeframe — you have earlier pay periods on record."}
            </Text>
          </Box>
        ) : (
          <Box>
            <HStack justify="space-between" align="start" gap={2} mb={2} wrap="wrap">
              <VStack align="start" gap={0} minW={0}>
                <Text fontSize="sm" fontWeight="bold" color="blue.900">
                  {shown.length === 1
                    ? `Paid ${fmtDateKey(newest!.payDay)}`
                    : `${shown.length} pay periods`}
                </Text>
                <Text fontSize="xs" color="blue.800">
                  {shown.length === 1
                    ? `for ${fmtDateKey(newest!.periodStart)} – ${fmtDateKey(newest!.periodEnd)}`
                    : `most recent paid ${fmtDateKey(newest!.payDay)}`}
                </Text>
              </VStack>
            </HStack>

            <SimpleGrid columns={2} gap={2}>
              <Figure label={shown.length === 1 ? "Net pay" : "Total net"} value={fmtPayrollMoney(totals.netPay)} />
              <Figure label={shown.length === 1 ? "Gross" : "Total gross"} value={fmtPayrollMoney(totals.grossEarnings)} />
            </SimpleGrid>

            <Text fontSize="2xs" color="blue.700" mt={2}>
              Actual amounts paid · {periods.length}{" "}
              {periods.length === 1 ? "period" : "periods"} on record
            </Text>
          </Box>
        )}
      </VStack>
    </Dashboard>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <VStack align="start" gap={0}>
      <Text fontSize="2xs" color="blue.700" textTransform="uppercase" letterSpacing="wide">
        {label}
      </Text>
      <Text
        fontSize="lg"
        fontWeight="bold"
        color="blue.800"
        lineHeight="1.1"
        fontVariantNumeric="tabular-nums"
      >
        {value}
      </Text>
    </VStack>
  );
}
