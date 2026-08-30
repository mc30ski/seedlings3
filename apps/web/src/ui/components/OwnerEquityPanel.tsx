"use client";

// ─────────────────────────────────────────────────────────────────────────────
// OwnerEquityPanel — what "My payday" means for the LLC owner.
//
// The owner is not on payroll. An LLC's owner takes money out as DRAWS and
// puts it in as CAPITAL CONTRIBUTIONS; neither is a wage, neither appears in
// a Gusto payroll run, and neither ever produces a PayrollPeriod row. So the
// payroll surfaces — Home's MY PAYDAY card and Money → Payroll — are
// permanently empty for exactly one person in the system, and "No payroll
// records yet" is a true but useless answer.
//
// This panel shows the equity movement for the same timeframe the payroll
// picker offers, sourced from BusinessExpense rows typed
// CAPITAL_CONTRIBUTION / OWNER_DRAW (the same rows the Ledger reports).
//
// Deliberately a SPECIAL CASE, not a generalisation: `User.isOwner` is
// enforced unique by a partial index, so this is one person, forever. The
// hosts branch on `me.isOwner` and are otherwise untouched.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, HStack, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
// fmtDate, not fmtDateKey: BusinessExpense.date arrives as a full ISO
// datetime, and fmtDateKey only accepts a bare YYYY-MM-DD key — it
// bailed to an em dash on every row.
import { fmtDate } from "@/src/lib/dates";
import { payrollRangeLabel, payrollRangeStart, type PayrollRangeKey } from "@/src/lib/payroll";

type EquityRow = {
  id: string;
  type: "CAPITAL_CONTRIBUTION" | "OWNER_DRAW";
  date: string;
  cost: number;
  description: string;
  paymentFrom?: string | null;
  notes?: string | null;
};

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function useOwnerEquity(range: PayrollRangeKey, enabled: boolean) {
  const [rows, setRows] = useState<EquityRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    // Hooks can't be conditional, but the fetch must be: this endpoint is
    // Super-only, so firing it for an ordinary worker is a guaranteed 403
    // and a spurious error toast.
    if (!enabled) {
      setRows(null);
      return;
    }
    setLoading(true);
    try {
      // `latest` has no meaning without pay periods — for the owner it
      // reads as "the most recent activity", so fall back to everything
      // and let the list's own ordering surface the newest first.
      const from = payrollRangeStart(range);
      const qs = (t: string) => {
        const p = new URLSearchParams({ type: t, all: "true" });
        if (from) p.set("from", from);
        return p.toString();
      };
      const [contrib, draws] = await Promise.all([
        apiGet<{ rows: EquityRow[] }>(`/api/admin/business-expenses?${qs("CAPITAL_CONTRIBUTION")}`),
        apiGet<{ rows: EquityRow[] }>(`/api/admin/business-expenses?${qs("OWNER_DRAW")}`),
      ]);
      const all = [...(contrib?.rows ?? []), ...(draws?.rows ?? [])].sort((a, b) =>
        b.date.localeCompare(a.date),
      );
      setRows(all);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load owner equity.", err) });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [range, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const contributions = (rows ?? []).filter((r) => r.type === "CAPITAL_CONTRIBUTION");
  const draws = (rows ?? []).filter((r) => r.type === "OWNER_DRAW");
  const inTotal = contributions.reduce((s, r) => s + r.cost, 0);
  const outTotal = draws.reduce((s, r) => s + r.cost, 0);

  return { rows, loading, load, contributions, draws, inTotal, outTotal, net: inTotal - outTotal };
}

/** Badge naming the reason this surface looks different. */
export function OwnerBadge() {
  return (
    <Badge colorPalette="purple" variant="solid" flexShrink={0}>
      LLC Owner
    </Badge>
  );
}

export default function OwnerEquityPanel({
  range,
  equity,
  full = false,
}: {
  range: PayrollRangeKey;
  equity: ReturnType<typeof useOwnerEquity>;
  /** Show every row instead of the most recent handful. The Home card is
   *  a summary and caps the list; the Payroll tab is where "View all"
   *  lands, so it has to actually be all of them. */
  full?: boolean;
}) {
  const { rows, loading, contributions, draws, inTotal, outTotal, net } = equity;

  if (loading && rows === null) {
    return (
      <HStack py={3} justify="center">
        <Spinner size="sm" />
        <Text fontSize="xs" color="fg.muted">Loading owner equity…</Text>
      </HStack>
    );
  }

  return (
    <VStack align="stretch" gap={2}>
      <HStack gap={2} wrap="wrap">
        <OwnerBadge />
        <Text fontSize="xs" color="fg.muted">
          You don&apos;t draw a wage. This is money you put IN and took OUT —{" "}
          {payrollRangeLabel(range).toLowerCase()}.
        </Text>
      </HStack>

      <SimpleGrid columns={3} gap={0} borderWidth="1px" borderColor="blue.200" borderRadius="md" overflow="hidden">
        <VStack align="center" gap={0} py={2} px={2}>
          <Text fontSize="2xs" color="blue.700" textTransform="uppercase" letterSpacing="wide">
            Contributed
          </Text>
          <Text fontSize="md" fontWeight="bold" color="green.700">{money(inTotal)}</Text>
          <Text fontSize="2xs" color="fg.muted">{contributions.length} in</Text>
        </VStack>
        <VStack align="center" gap={0} py={2} px={2} borderLeftWidth="1px" borderColor="blue.200">
          <Text fontSize="2xs" color="blue.700" textTransform="uppercase" letterSpacing="wide">
            Drawn
          </Text>
          <Text fontSize="md" fontWeight="bold" color="orange.700">{money(outTotal)}</Text>
          <Text fontSize="2xs" color="fg.muted">{draws.length} out</Text>
        </VStack>
        <VStack align="center" gap={0} py={2} px={2} borderLeftWidth="1px" borderColor="blue.200">
          <Text fontSize="2xs" color="blue.700" textTransform="uppercase" letterSpacing="wide">
            Net
          </Text>
          {/* Net is contributions − draws: positive means you have put more
              in than you have taken out over this window. */}
          <Text fontSize="md" fontWeight="bold" color={net >= 0 ? "green.800" : "orange.800"}>
            {money(net)}
          </Text>
          <Text fontSize="2xs" color="fg.muted">{net >= 0 ? "into the business" : "out of the business"}</Text>
        </VStack>
      </SimpleGrid>

      {(rows ?? []).length === 0 ? (
        <Text fontSize="sm" color="fg.muted" py={1}>
          No contributions or draws recorded {payrollRangeLabel(range).toLowerCase()}.
        </Text>
      ) : (
        <VStack align="stretch" gap={1}>
          {(full ? (rows ?? []) : (rows ?? []).slice(0, 12)).map((r) => (
            <HStack
              key={r.id}
              gap={2}
              px={2}
              py={1.5}
              borderWidth="1px"
              borderColor="blue.200"
              bg="blue.50"
              rounded="md"
              fontSize="xs"
              wrap="wrap"
            >
              <Badge
                size="sm"
                colorPalette={r.type === "CAPITAL_CONTRIBUTION" ? "green" : "orange"}
                variant="solid"
                flexShrink={0}
              >
                {r.type === "CAPITAL_CONTRIBUTION" ? "In" : "Out"}
              </Badge>
              <Text color="fg.muted" flexShrink={0}>{fmtDate(r.date)}</Text>
              <Text flex="1" minW="120px" lineClamp={1}>{r.description}</Text>
              {r.paymentFrom && (
                <Text color="fg.muted" flexShrink={0} lineClamp={1}>{r.paymentFrom}</Text>
              )}
              <Text fontWeight="bold" flexShrink={0}>{money(r.cost)}</Text>
            </HStack>
          ))}
          {!full && (rows ?? []).length > 12 && (
            <Text fontSize="2xs" color="fg.muted">
              Showing the 12 most recent of {(rows ?? []).length} — View all for the rest.
            </Text>
          )}
        </VStack>
      )}
    </VStack>
  );
}
