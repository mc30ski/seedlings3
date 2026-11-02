"use client";

/**
 * INSIGHTS → PERFORMANCE — how each portfolio is doing, side by side.
 *
 * WHY IT IS NOT PART OF STATISTICS, which is the obvious place and the
 * wrong one. Statistics compares PEOPLE, and people are a flat list —
 * every person is comparable to every other, so one bar each is the whole
 * interaction. Portfolios are a TREE. Chapel Hill is not a peer of Chapel
 * Hill South, it CONTAINS it, so a row per portfolio means nothing until
 * you have chosen a level, and then you need to drill in and climb back
 * out. That is a different page, not a toggle.
 *
 * The metric sets differ too. Earnings per Hour and Efficiency describe
 * how a worker performs; revenue per property describes a book of
 * business and has no meaning for a person.
 *
 * A TABLE, NOT BARS. Bars are right for one metric across a flat set.
 * Here you want five metrics at once per portfolio, sortable, with the
 * change against last period beside them — which is a table.
 *
 * THE DIVISION OF LABOUR:
 *   · Statistics  — people compared, plus the lensed territory's totals.
 *   · Performance — territories compared against each other.
 *   · Portfolios  — where you ACT on the answer: re-tag, move, retire.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Card, HStack, Input, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { ChevronRight, CornerLeftUp, Layers } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { bizToday, bizAddDays, type EtDateKey } from "@/src/lib/dates";
import { paletteFor } from "@/src/lib/portfolioColors";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";
import type { Scope } from "@/src/lib/scope";

type Row = {
  id: string | null;
  name: string;
  tier: string | null;
  color: string | null;
  hasChildren: boolean;
  retired: boolean;
  revenue: number;
  visits: number;
  propertiesWorked: number;
  avgJobValue: number;
  revenuePerProperty: number;
  previous: { revenue: number; visits: number };
};

type Response = {
  parent: { id: string; name: string } | null;
  rows: Row[];
  direct: Row | null;
  range: { from: string; to: string; prevFrom: string; prevTo: string } | null;
};

const money = (n: number) => `$${n.toFixed(2)}`;

/** Which column the table is ordered by. Revenue first: it is the question. */
type SortKey = "revenue" | "visits" | "propertiesWorked" | "avgJobValue" | "revenuePerProperty";

export default function PerformanceTab({ scope }: { scope: Scope }) {
  void scope;
  const [to, setTo] = useState<EtDateKey>(() => bizToday());
  const [from, setFrom] = useState<EtDateKey>(() => bizAddDays(bizToday(), -29));
  /** The drill-down stack. Empty = the top of whatever this reader can see. */
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<SortKey>("revenue");

  const parentId = trail.length > 0 ? trail[trail.length - 1].id : null;

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const q = new URLSearchParams({ from, to });
      if (parentId) q.set("parentId", parentId);
      setData(await apiGet<Response>(`/api/reports/portfolio-performance?${q.toString()}`));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [from, to, parentId]);
  useEffect(() => { void load(); }, [load]);

  /** Rows plus the "directly here" row, ordered by the chosen column. */
  const rows = useMemo(() => {
    const all = [...(data?.rows ?? []), ...(data?.direct ? [data.direct] : [])];
    return all.sort((a, b) => b[sort] - a[sort]);
  }, [data, sort]);

  const totals = useMemo(
    () => rows.reduce((t, r) => ({ revenue: t.revenue + r.revenue, visits: t.visits + r.visits }), { revenue: 0, visits: 0 }),
    [rows],
  );

  /** The change against the previous period of the same length. Returns
   *  null when there is no base to compare against — "+100%" from zero is
   *  arithmetic, not information. */
  const delta = (nowV: number, prevV: number) => {
    if (prevV <= 0) return null;
    return ((nowV - prevV) / prevV) * 100;
  };

  const Header = ({ label, k }: { label: string; k: SortKey }) => (
    <Table.ColumnHeader
      textAlign="end"
      cursor="pointer"
      onClick={() => setSort(k)}
      color={sort === k ? "purple.fg" : undefined}
      fontWeight={sort === k ? "bold" : undefined}
      whiteSpace="nowrap"
    >
      {label}
    </Table.ColumnHeader>
  );

  return (
    <VStack align="stretch" gap={3}>
      <TabExplainer explainerId="seedlings:performanceTab:guideOpen">
        <ExplainerText>
          How your portfolios are doing <Em>against each other</Em> — revenue,
          visits, properties and what each property is worth, over a period you
          choose.
        </ExplainerText>
        <ExplainerText>
          Statistics compares <Em>people</Em>. This compares <Em>places</Em>.
          You drill down from the top, so you are always comparing things that
          sit at the same level.
        </ExplainerText>
        <ExplainerText>
          <Em>Rows do not add up to the whole business.</Em> A property in a zone
          and in a Book belongs to both, so it counts in both rows. That is the
          membership being honest, not a miscount.
        </ExplainerText>
      </TabExplainer>

      <HStack gap={3} wrap="wrap" align="end">
        <Box>
          <Text fontSize="2xs" color="fg.muted" mb={1}>From</Text>
          <Input size="sm" type="date" value={from} onChange={(e) => setFrom(e.target.value as EtDateKey)} />
        </Box>
        <Box>
          <Text fontSize="2xs" color="fg.muted" mb={1}>To</Text>
          <Input size="sm" type="date" value={to} onChange={(e) => setTo(e.target.value as EtDateKey)} />
        </Box>
        {data?.range && (
          <Text fontSize="2xs" color="fg.muted" pb={2}>
            compared with {data.range.prevFrom} → {data.range.prevTo}
          </Text>
        )}
      </HStack>

      {/* WHERE YOU ARE IN THE TREE. The drill-down IS the level picker —
          there is no abstract "choose a depth" control, because the
          question is always "compare the children of this". */}
      <HStack gap={1} wrap="wrap">
        <Button size="xs" variant="ghost" onClick={() => setTrail([])} disabled={trail.length === 0}>
          Top
        </Button>
        {trail.map((t, i) => (
          <HStack key={t.id} gap={1}>
            <ChevronRight size={12} />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setTrail(trail.slice(0, i + 1))}
              disabled={i === trail.length - 1}
            >
              {t.name}
            </Button>
          </HStack>
        ))}
        {trail.length > 0 && (
          <Button size="xs" variant="outline" ml={2} onClick={() => setTrail(trail.slice(0, -1))}>
            <CornerLeftUp size={12} /> Up
          </Button>
        )}
      </HStack>

      {loading && <Box py={10} textAlign="center"><Spinner /></Box>}
      {failed && <Text fontSize="sm" color="red.fg">Couldn&rsquo;t load the comparison.</Text>}

      {!loading && !failed && data && (
        <Card.Root variant="outline">
          <Card.Header py="2" px="3" pb="1">
            <HStack justify="space-between" wrap="wrap" gap={2}>
              <Text fontSize="sm" fontWeight="semibold">
                Inside {data.parent?.name ?? "the business"}
                <Text as="span" color="fg.muted" fontWeight="normal"> · {rows.length}</Text>
              </Text>
              <Text fontSize="2xs" color="fg.muted">
                {money(totals.revenue)} · {totals.visits} visits
              </Text>
            </HStack>
          </Card.Header>
          <Card.Body py="2" px="3">
            {rows.length === 0 ? (
              <Text fontSize="xs" color="fg.muted">
                Nothing inside {data.parent?.name ?? "this"} produced work in this period.
              </Text>
            ) : (
              <Box overflowX="auto">
                <Table.Root size="sm" variant="line">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Portfolio</Table.ColumnHeader>
                      <Header label="Revenue" k="revenue" />
                      <Table.ColumnHeader textAlign="end" whiteSpace="nowrap">vs prev</Table.ColumnHeader>
                      <Header label="Visits" k="visits" />
                      <Header label="Properties" k="propertiesWorked" />
                      <Header label="Avg job" k="avgJobValue" />
                      <Header label="Per property" k="revenuePerProperty" />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {rows.map((r, i) => {
                      const d = delta(r.revenue, r.previous.revenue);
                      const palette = r.id ? paletteFor({ color: r.color }, i) : null;
                      return (
                        <Table.Row key={r.id ?? "__direct__"}>
                          <Table.Cell>
                            <HStack gap={2} minW={0}>
                              {palette && (
                                <Box w="8px" h="8px" rounded="full" bg={`${palette}.solid`} flexShrink={0} />
                              )}
                              {r.hasChildren ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  px={0}
                                  onClick={() => setTrail([...trail, { id: r.id!, name: r.name }])}
                                  title={`Compare what is inside ${r.name}`}
                                >
                                  {r.name} <ChevronRight size={12} />
                                </Button>
                              ) : (
                                <Text fontSize="sm">{r.name}</Text>
                              )}
                              {r.tier && <Text fontSize="2xs" color="fg.muted">{r.tier}</Text>}
                              {r.retired && <Text fontSize="2xs" color="orange.fg">retired</Text>}
                            </HStack>
                          </Table.Cell>
                          <Table.Cell textAlign="end" fontWeight="semibold">{money(r.revenue)}</Table.Cell>
                          <Table.Cell textAlign="end">
                            {/* NO PERCENTAGE OUT OF NOTHING. A zone that
                                earned nothing last period and something
                                this one is not "up 100%" — it has no base,
                                and saying a number there is worse than
                                saying none. */}
                            {d === null ? (
                              <Text fontSize="2xs" color="fg.subtle">—</Text>
                            ) : (
                              <Text fontSize="xs" color={d >= 0 ? "green.fg" : "red.fg"}>
                                {d >= 0 ? "+" : ""}{d.toFixed(0)}%
                              </Text>
                            )}
                          </Table.Cell>
                          <Table.Cell textAlign="end">{r.visits}</Table.Cell>
                          <Table.Cell textAlign="end">{r.propertiesWorked}</Table.Cell>
                          <Table.Cell textAlign="end">{money(r.avgJobValue)}</Table.Cell>
                          <Table.Cell textAlign="end">{money(r.revenuePerProperty)}</Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              </Box>
            )}
            <HStack gap={2} mt={2} align="start">
              <Box color="fg.muted" mt="2px"><Layers size={11} /></Box>
              <Text fontSize="2xs" color="fg.muted">
                Properties counts those that produced a visit in this period, not
                everything filed here. A property in two portfolios counts in both
                rows, so the column adds up to more than the business total. Each row
                covers everything its current properties earned, so re-filing one
                moves its past earnings to the new row.
              </Text>
            </HStack>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
