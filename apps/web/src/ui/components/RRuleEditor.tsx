"use client";

import { useEffect, useState } from "react";
import {
  Box,
  HStack,
  Input,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";

/**
 * Minimal RRULE editor — covers the cases this app actually needs (annual
 * compliance dates, monthly billing, weekly meetings) without pulling in a
 * full calendar-rule UI library. Outputs an RFC 5545 RRULE string (no
 * leading "RRULE:" prefix, no DTSTART — the parent owns the anchor date).
 * Empty output = one-time event.
 */

type Freq = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

const FREQ_ITEMS: { label: string; value: Freq }[] = [
  { label: "One time (no repeat)", value: "NONE" },
  { label: "Daily", value: "DAILY" },
  { label: "Weekly", value: "WEEKLY" },
  { label: "Monthly", value: "MONTHLY" },
  { label: "Yearly", value: "YEARLY" },
];

const WEEKDAYS: { label: string; value: string }[] = [
  { label: "Sun", value: "SU" },
  { label: "Mon", value: "MO" },
  { label: "Tue", value: "TU" },
  { label: "Wed", value: "WE" },
  { label: "Thu", value: "TH" },
  { label: "Fri", value: "FR" },
  { label: "Sat", value: "SA" },
];

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** The anchor date — used to derive sensible defaults (the month/day). */
  anchorDate: string;
};

function parseRRule(rule: string): {
  freq: Freq;
  interval: number;
  byDay: string[];
  byMonth?: number;
  byMonthDay?: number;
} {
  if (!rule) return { freq: "NONE", interval: 1, byDay: [] };
  const parts = rule
    .replace(/^RRULE:/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const map: Record<string, string> = {};
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k) map[k.toUpperCase()] = v ?? "";
  }
  const freqRaw = (map.FREQ || "").toUpperCase();
  const freq: Freq = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freqRaw)
    ? (freqRaw as Freq)
    : "NONE";
  const interval = Math.max(1, Number(map.INTERVAL) || 1);
  const byDay = (map.BYDAY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const byMonth = map.BYMONTH ? Number(map.BYMONTH) : undefined;
  const byMonthDay = map.BYMONTHDAY ? Number(map.BYMONTHDAY) : undefined;
  return { freq, interval, byDay, byMonth, byMonthDay };
}

function buildRRule(state: {
  freq: Freq;
  interval: number;
  byDay: string[];
  byMonth?: number;
  byMonthDay?: number;
}): string {
  if (state.freq === "NONE") return "";
  const parts: string[] = [`FREQ=${state.freq}`];
  if (state.interval > 1) parts.push(`INTERVAL=${state.interval}`);
  if (state.freq === "WEEKLY" && state.byDay.length > 0) {
    parts.push(`BYDAY=${state.byDay.join(",")}`);
  }
  if (state.freq === "MONTHLY" && state.byMonthDay) {
    parts.push(`BYMONTHDAY=${state.byMonthDay}`);
  }
  if (state.freq === "YEARLY") {
    if (state.byMonth) parts.push(`BYMONTH=${state.byMonth}`);
    if (state.byMonthDay) parts.push(`BYMONTHDAY=${state.byMonthDay}`);
  }
  return parts.join(";");
}

export default function RRuleEditor({ value, onChange, anchorDate }: Props) {
  const initial = parseRRule(value);
  const [freq, setFreq] = useState<Freq>(initial.freq);
  const [interval, setIntervalState] = useState<number>(initial.interval);
  const [byDay, setByDay] = useState<string[]>(initial.byDay);
  const [byMonth, setByMonth] = useState<number | undefined>(initial.byMonth);
  const [byMonthDay, setByMonthDay] = useState<number | undefined>(initial.byMonthDay);

  // When the anchor changes, seed defaults for YEARLY / MONTHLY based on it
  // so the user doesn't have to type them in. Only fires when the field is
  // empty — never overwrites a value the user picked manually.
  useEffect(() => {
    if (!anchorDate) return;
    // The anchor input is a YYYY-MM-DD string (calendar date, not a moment),
    // but `new Date("YYYY-MM-DD")` parses as UTC midnight — then reading
    // .getMonth()/.getDate() returns local-time components, which shifts a
    // day earlier in negative-offset zones (e.g., 2027-01-15 → "Jan 14" in
    // Eastern). Parse the string parts directly so the picker matches what
    // the user typed.
    const [yStr, mStr, dStr] = anchorDate.split("-");
    const m = Number(mStr);
    const day = Number(dStr);
    if (!yStr || !m || !day) return;
    if (freq === "YEARLY") {
      if (!byMonth) setByMonth(m);
      if (!byMonthDay) setByMonthDay(day);
    } else if (freq === "MONTHLY") {
      if (!byMonthDay) setByMonthDay(day);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, anchorDate]);

  // Emit changes upward whenever any state piece moves.
  useEffect(() => {
    onChange(buildRRule({ freq, interval, byDay, byMonth, byMonthDay }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, interval, byDay, byMonth, byMonthDay]);

  const freqCollection = createListCollection({ items: FREQ_ITEMS });

  return (
    <VStack align="stretch" gap={2}>
      <Box>
        <Text fontSize="xs" fontWeight="medium" mb={1}>Repeats</Text>
        <Select.Root
          collection={freqCollection}
          value={[freq]}
          onValueChange={(e) => setFreq((e.value[0] as Freq) || "NONE")}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="One time" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {FREQ_ITEMS.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
      </Box>

      {freq !== "NONE" && (
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>Every</Text>
          <HStack gap={2}>
            <Input
              type="number"
              size="sm"
              min={1}
              value={interval}
              onChange={(e) => setIntervalState(Math.max(1, Number(e.target.value) || 1))}
              w="80px"
            />
            <Text fontSize="sm" color="fg.muted">
              {freq === "DAILY" && (interval === 1 ? "day" : "days")}
              {freq === "WEEKLY" && (interval === 1 ? "week" : "weeks")}
              {freq === "MONTHLY" && (interval === 1 ? "month" : "months")}
              {freq === "YEARLY" && (interval === 1 ? "year" : "years")}
            </Text>
          </HStack>
        </Box>
      )}

      {freq === "WEEKLY" && (
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>On these days</Text>
          <HStack gap={1} wrap="wrap">
            {WEEKDAYS.map((d) => {
              const active = byDay.includes(d.value);
              return (
                <Box
                  key={d.value}
                  px="2"
                  py="1"
                  fontSize="xs"
                  fontWeight="medium"
                  borderRadius="full"
                  cursor="pointer"
                  bg={active ? "teal.500" : "gray.100"}
                  color={active ? "white" : "fg.default"}
                  onClick={() =>
                    setByDay((prev) =>
                      prev.includes(d.value)
                        ? prev.filter((x) => x !== d.value)
                        : [...prev, d.value],
                    )
                  }
                >
                  {d.label}
                </Box>
              );
            })}
          </HStack>
        </Box>
      )}

      {freq === "MONTHLY" && (
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>Day of month</Text>
          <Input
            type="number"
            size="sm"
            min={1}
            max={31}
            value={byMonthDay ?? ""}
            onChange={(e) => setByMonthDay(Number(e.target.value) || undefined)}
            w="80px"
          />
        </Box>
      )}

      {freq === "YEARLY" && (
        <HStack gap={2}>
          <Box flex="1">
            <Text fontSize="xs" fontWeight="medium" mb={1}>Month</Text>
            <Input
              type="number"
              size="sm"
              min={1}
              max={12}
              value={byMonth ?? ""}
              onChange={(e) => setByMonth(Number(e.target.value) || undefined)}
            />
          </Box>
          <Box flex="1">
            <Text fontSize="xs" fontWeight="medium" mb={1}>Day</Text>
            <Input
              type="number"
              size="sm"
              min={1}
              max={31}
              value={byMonthDay ?? ""}
              onChange={(e) => setByMonthDay(Number(e.target.value) || undefined)}
            />
          </Box>
        </HStack>
      )}
    </VStack>
  );
}

/**
 * Human-readable summary of an RRULE string for display in cards/lists.
 * Returns "" for one-time (empty rrule).
 */
export function rruleLabel(rrule: string | null | undefined): string {
  if (!rrule) return "";
  const s = parseRRule(rrule);
  if (s.freq === "NONE") return "";
  const every = s.interval > 1 ? `every ${s.interval} ` : "";
  if (s.freq === "DAILY") return `${every}${s.interval === 1 ? "Daily" : "days"}`.trim();
  if (s.freq === "WEEKLY") {
    if (s.byDay.length === 0) return s.interval === 1 ? "Weekly" : `Every ${s.interval} weeks`;
    const days = s.byDay
      .map((k) => WEEKDAYS.find((w) => w.value === k)?.label ?? k)
      .join(", ");
    return s.interval === 1 ? `Weekly on ${days}` : `Every ${s.interval} weeks on ${days}`;
  }
  if (s.freq === "MONTHLY") {
    const day = s.byMonthDay ? ` on the ${ordinal(s.byMonthDay)}` : "";
    return `${s.interval === 1 ? "Monthly" : `Every ${s.interval} months`}${day}`;
  }
  if (s.freq === "YEARLY") {
    const monthName = s.byMonth
      ? new Date(2000, s.byMonth - 1, 1).toLocaleString("en-US", { month: "long" })
      : "";
    const day = s.byMonthDay ?? "";
    const when = monthName && day ? ` on ${monthName} ${day}` : monthName ? ` in ${monthName}` : "";
    return `${s.interval === 1 ? "Yearly" : `Every ${s.interval} years`}${when}`;
  }
  return "";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
