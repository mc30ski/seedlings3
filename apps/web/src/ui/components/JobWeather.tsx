"use client";

import { useState } from "react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { ChevronDown, ChevronRight, CloudSun, RefreshCw } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDateTime } from "@/src/lib/dates";
import type { WeatherSnapshot } from "@/src/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Weather on a job card — two halves that answer different questions.
//
//   RECORDED   what it actually was when the job was started and finished.
//              Already in our database by the time the card renders, so it
//              costs nothing and is always shown.
//
//   FORECAST   hour by hour for the day, from NWS. Fetched ONLY when the
//              section is opened. The feed renders dozens of cards and the
//              operator was explicit: no weather call per job unless somebody
//              actually asks for it.
// ─────────────────────────────────────────────────────────────────────────────

type ForecastHour = {
  startTime: string;
  label: string;
  axisLabel: string;
  tempF: number | null;
  /** Chance of rain — the question for hours still ahead. */
  precipPct: number | null;
  /** Rain that actually fell, inches — the question for hours already gone. */
  precipIn: number | null;
  windMph: number | null;
  shortForecast: string | null;
  isPast: boolean;
  isCurrentHour: boolean;
};
type HourlyForecast =
  | { available: true; hours: ForecastHour[]; dateKey: string; isToday: boolean; measuredAvailable: boolean; locatedBy: string; fetchedAt: string; stale: boolean }
  | { available: false; reason: string; message: string };

const iconUrl = (code: string | null) =>
  code ? `https://openweathermap.org/img/wn/${code}.png` : null;

/** One frozen reading, rendered inline. */
function RecordedReading({ label, wx }: { label: string; wx: WeatherSnapshot }) {
  const url = iconUrl(wx.icon);
  return (
    <HStack gap={1.5} align="center">
      <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" fontWeight="medium">
        {label}
      </Text>
      {url && <img src={url} alt="" width={22} height={22} style={{ display: "block" }} />}
      <Text fontSize="xs" fontWeight="medium">
        {wx.tempF != null ? `${Math.round(wx.tempF)}°` : "—"}
      </Text>
      {wx.description && (
        <Text fontSize="xs" color="fg.muted">{wx.description}</Text>
      )}
      {/* The reading is evidence, so it carries its provenance. "gps" means
          the worker's own phone at the moment they pressed the button. */}
      <Text
        fontSize="2xs"
        color="fg.muted"
        title={`Recorded ${fmtDateTime(wx.capturedAt)} from ${
          wx.locatedBy === "gps" ? "the worker's location" : "the property's location"
        }`}
      >
        {wx.locatedBy === "gps" ? "· on site" : ""}
      </Text>
    </HStack>
  );
}

/**
 * The hourly bar chart — the whole day, both directions from now.
 *
 * TWO QUANTITIES, DRAWN DIFFERENTLY, because they answer different questions:
 *
 *   BEFORE NOW   how much rain FELL, from reanalysis. The operator's reason
 *                for wanting it: "it might be that there was rain early that
 *                day, and that could effect if i decide to go out there if
 *                it's too wet." Whether the ground is soaked is a
 *                measurement, not a probability — "a 40% chance it rained at
 *                9am" is not a thing.
 *
 *                This shipped reading the FORECAST endpoint's past hours,
 *                which are the current model run's guess at them and get
 *                rewritten every reissue. It was wrong by enough to flip the
 *                decision: it showed a dry morning and a wet 4pm on a day that
 *                was the other way round.
 *
 *   AFTER NOW    the CHANCE of rain, which is all a forecast can offer.
 *
 * They get separate scales and separate fills, because a 0.1in bar and a 30%
 * bar share no axis. The boundary between them is the "now" column, which is
 * the darkest thing on the chart.
 *
 * A null value is NOT drawn as a zero bar — "we don't know" rendered flat
 * reads as "it's dry", which is the one misreading that would actually send a
 * crew out. Zero is different: a past hour that measured 0.00in is a known dry
 * hour and draws as a baseline.
 */
function HourlyChart({ hours }: { hours: ForecastHour[] }) {
  // Independent maxima. Floors keep a quiet day from rendering one stray
  // reading as a full-height bar.
  const maxRain = Math.max(0.1, ...hours.map((h) => (h.isPast ? h.precipIn ?? 0 : 0)));
  const maxPct = Math.max(40, ...hours.map((h) => (h.isPast ? 0 : h.precipPct ?? 0)));

  return (
    <Box overflowX="auto" pb={1}>
      <HStack gap={0.5} align="flex-end" minW="max-content">
        {hours.map((h) => {
          // The current hour is not finished, so it is read as a forecast: its
          // rainfall so far is a partial number and would understate the hour.
          const measured = h.isPast;
          const value = measured ? h.precipIn : h.precipPct;
          const known = value != null;
          const heightPct = !known
            ? 0
            : measured
              ? Math.max(2, ((value as number) / maxRain) * 100)
              : Math.max(2, ((value as number) / maxPct) * 100);

          const barBg = !known
            ? "transparent"
            : h.isCurrentHour
              ? "blue.600"
              : measured
                ? "cyan.600"
                : "blue.300";

          return (
            <VStack
              key={h.startTime}
              gap={0.5}
              minW="30px"
              title={`${h.label}${h.isCurrentHour ? " (now)" : ""} · ${h.tempF != null ? Math.round(h.tempF) + "°F" : "—"} · ${
                measured
                  ? h.precipIn == null
                    ? "no rainfall data"
                    : h.precipIn > 0
                      ? `${h.precipIn}in of rain fell`
                      : "no rain fell"
                  : h.precipPct == null
                    ? "no precipitation data"
                    : `${h.precipPct}% chance of rain`
              }${h.windMph != null ? ` · wind ${Math.round(h.windMph)} mph` : ""}${
                h.shortForecast ? ` · ${h.shortForecast}` : ""
              }`}
            >
              {/* The number over the bar carries its own unit, so the two
                  halves of the chart can never be read as one series. */}
              <Text
                fontSize="2xs"
                color={measured ? "cyan.700" : "fg.muted"}
                fontVariantNumeric="tabular-nums"
                whiteSpace="nowrap"
              >
                {!known
                  ? "–"
                  : measured
                    ? (value as number) > 0
                      ? `${(value as number).toFixed(2).replace(/^0/, "")}"`
                      : "0"
                    : `${value}`}
              </Text>
              <Box
                w="full"
                h="46px"
                display="flex"
                alignItems="flex-end"
                bg={h.isCurrentHour ? "blue.100" : "transparent"}
                borderRadius="sm"
              >
                <Box
                  w="full"
                  h={`${heightPct}%`}
                  minH={known && measured && (value as number) === 0 ? "2px" : undefined}
                  bg={barBg}
                  borderTopRadius="sm"
                  borderWidth={!known ? "1px" : undefined}
                  borderStyle={!known ? "dashed" : undefined}
                  borderColor={!known ? "border" : undefined}
                />
              </Box>
              <Text
                fontSize="2xs"
                color={h.isCurrentHour ? "blue.fg" : "fg.muted"}
                fontWeight={h.isCurrentHour ? "bold" : undefined}
                fontVariantNumeric="tabular-nums"
              >
                {/* "now" rather than the hour on the current column — the
                    reader is looking for where they are, not what o'clock it
                    is, and they already know that.

                    axisLabel, not a slice of the label: slicing a 12-hour
                    string gives "4:" and a 24-hour one gives an hour the rest
                    of this card does not use. */}
                {h.isCurrentHour ? "now" : h.axisLabel}
              </Text>
              <Text fontSize="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
                {h.tempF != null ? `${Math.round(h.tempF)}°` : ""}
              </Text>
            </VStack>
          );
        })}
      </HStack>
    </Box>
  );
}

export default function JobWeather({
  occurrenceId,
  startWeather,
  completeWeather,
  /** Hide the forecast half entirely — e.g. for a completed visit, where the
   *  recorded readings are the whole story and a forecast would be noise. */
  showForecast = true,
}: {
  occurrenceId: string;
  startWeather?: WeatherSnapshot | null;
  completeWeather?: WeatherSnapshot | null;
  showForecast?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HourlyForecast | null>(null);
  const [loading, setLoading] = useState(false);

  const hasRecorded = !!(startWeather || completeWeather);
  if (!hasRecorded && !showForecast) return null;

  async function load(refresh = false) {
    setLoading(true);
    try {
      setData(await apiGet<HourlyForecast>(
        `/api/occurrences/${occurrenceId}/hourly-weather${refresh ? "?refresh=1" : ""}`,
      ));
    } catch {
      setData({
        available: false,
        reason: "unavailable",
        message: "Couldn't load the forecast just now.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    // FETCH ON FIRST OPEN ONLY. Not on mount, not on render, and not again
    // once we have an answer — reopening a section the operator already
    // looked at must not re-hit the service.
    if (next && !data && !loading) await load();
  }

  return (
    // A BORDERED SECTION, not a ghost link in a stack of them. This decides
    // whether a crew drives out at all, which is why it now opens the card —
    // directly under the title, or under the instructions band when there is
    // one. An operator scanning a card has to find it without reading every
    // line, and on a phone they stop scrolling long before the bottom.
    <Box
      w="full"
      mt={2}
      borderWidth="1px"
      borderColor="blue.300"
      bg="blue.50"
      borderRadius="xl"
      overflow="hidden"
    >
      {hasRecorded && (
        <HStack gap={3} wrap="wrap" px={2.5} py={1.5} borderBottomWidth={showForecast ? "1px" : undefined} borderColor="blue.200">
          {startWeather && <RecordedReading label="At start" wx={startWeather} />}
          {completeWeather && <RecordedReading label="At finish" wx={completeWeather} />}
        </HStack>
      )}

      {showForecast && (
        <Box>
          <Box
            as="button"
            w="full"
            textAlign="left"
            px={2.5}
            py={2}
            display="flex"
            alignItems="center"
            gap={1.5}
            cursor="pointer"
            _hover={{ bg: "blue.100" }}
            onClick={(e: any) => { e.stopPropagation(); void toggle(); }}
          >
            <Box color="blue.fg" display="inline-flex">
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </Box>
            <Box color="blue.fg" display="inline-flex"><CloudSun size={15} /></Box>
            <Text fontSize="sm" fontWeight="semibold" color="blue.fg">Hourly weather</Text>
            {/* Says what opening it will do, since nothing is fetched until
                then — an empty section with no explanation reads as broken. */}
            {!open && !data && (
              <Text fontSize="2xs" color="fg.muted" ml="auto">
                tap to check the forecast
              </Text>
            )}
            {/* Once the server says the chart is switched off, stop inviting
                the tap. The reason text explains why when it is open. */}
            {!open && data?.available === false && data.reason === "disabled" && (
              <Text fontSize="2xs" color="fg.muted" ml="auto">
                turned off in Settings
              </Text>
            )}
          </Box>

          {open && (
            <Box px={2.5} pb={2.5} pt={1}>
              {loading && (
                <HStack gap={2}><Spinner size="xs" /><Text fontSize="xs" color="fg.muted">Checking the forecast…</Text></HStack>
              )}
              {!loading && data?.available === false && (
                <Text fontSize="xs" color="fg.muted">{data.message}</Text>
              )}
              {!loading && data?.available === true && (
                <VStack align="stretch" gap={1}>
                  {/* Says which day is on screen and, on a future one, why no
                      column is marked — an unmarked chart otherwise reads as a
                      broken marker. */}
                  {/* A LEGEND, because the chart carries two different
                      quantities and nothing else on screen says so. Teal bars
                      are inches that fell, blue bars are a percentage chance,
                      and they share no axis. */}
                  {data.isToday ? (
                    <HStack gap={2.5} wrap="wrap" fontSize="2xs" color="fg.muted">
                      <HStack gap={1}>
                        <Box w="8px" h="8px" borderRadius="2px" bg="cyan.600" />
                        <Text>rain recorded (in)</Text>
                      </HStack>
                      <HStack gap={1}>
                        <Box w="8px" h="8px" borderRadius="2px" bg="blue.600" />
                        <Text>now</Text>
                      </HStack>
                      <HStack gap={1}>
                        <Box w="8px" h="8px" borderRadius="2px" bg="blue.300" />
                        <Text>chance of rain (%)</Text>
                      </HStack>
                      <Text>· times are ET</Text>
                    </HStack>
                  ) : (
                    <HStack gap={2.5} wrap="wrap" fontSize="2xs" color="fg.muted">
                      <HStack gap={1}>
                        <Box w="8px" h="8px" borderRadius="2px" bg="blue.300" />
                        <Text>chance of rain (%) — the whole day, all still ahead</Text>
                      </HStack>
                      <Text>· times are ET</Text>
                    </HStack>
                  )}
                  <HourlyChart hours={data.hours} />
                  {data.isToday && !data.measuredAvailable && (
                    <Text fontSize="2xs" color="orange.700">
                      Couldn't reach the record of what already fell, so this
                      morning's hours show as unknown rather than guessed.
                    </Text>
                  )}
                  {/* A forecast is a probability for a ~2.5km square, not a
                      promise about one lawn. Say so rather than letting a
                      crisp chart imply certainty. */}
                  <HStack gap={2} align="flex-start">
                    <Text fontSize="2xs" color="fg.muted" flex="1">
                      Open-Meteo for this property, as of{" "}
                      {fmtDateTime(data.fetchedAt)}
                      {data.stale ? " (last good reading — the service didn't answer just now)" : ""}. A
                      forecast is a chance, not a guarantee. Hours already
                      past are the recorded reanalysis for this grid square,
                      not the forecast's own account of them.
                    </Text>
                    {/* NEXT TO THE "AS OF" STAMP, not in the header — the
                        moment someone reads how old the reading is, is the
                        moment they decide whether they want a newer one.
                        Drops our cached copy rather than re-reading it; NWS
                        reissues roughly hourly, so an immediate re-press can
                        honestly return the same numbers with a newer stamp. */}
                    <Box
                      as="button"
                      flexShrink={0}
                      title="Fetch the latest forecast"
                      aria-label="Refresh forecast"
                      color="blue.fg"
                      p="1"
                      borderRadius="sm"
                      _hover={{ bg: "blue.100" }}
                      onClick={(e: any) => { e.stopPropagation(); void load(true); }}
                    >
                      <RefreshCw size={13} />
                    </Box>
                  </HStack>
                </VStack>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
