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
  tempF: number | null;
  precipPct: number | null;
  windMph: number | null;
  shortForecast: string | null;
  isCurrentHour: boolean;
};
type HourlyForecast =
  | { available: true; hours: ForecastHour[]; dateKey: string; isToday: boolean; locatedBy: string; fetchedAt: string; stale: boolean }
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
 * The hourly bar chart.
 *
 * PRECIPITATION IS THE BAR, temperature is a label. "Can we mow at 2pm" is a
 * rain question first; a chart that made temperature the tall thing would put
 * the least useful number in the most prominent place.
 *
 * A null precipitation is NOT drawn as a zero bar — NWS omits the field
 * sometimes, and "we don't know" rendered as a flat bar reads as "it's dry",
 * which is the one misreading that would actually send a crew out.
 *
 * THE MARKED COLUMN IS NOW, and nothing else. It used to be the hours the
 * visit was "booked" for — but jobs here are scheduled by DAY, so that came
 * from the time component of `startAt`, which is a storage artifact: in
 * production 500 of 527 occurrences carry one of exactly two of them. The
 * chart was pointing at 1pm or 4pm depending on which code path wrote the row
 * and captioning it as the booked hours. On a future day nothing is marked,
 * which is correct — there is no "now" on Thursday.
 */
function HourlyChart({ hours }: { hours: ForecastHour[] }) {
  const max = Math.max(40, ...hours.map((h) => h.precipPct ?? 0));
  return (
    <Box overflowX="auto" pb={1}>
      <HStack gap={0.5} align="flex-end" minW="max-content">
        {hours.map((h) => {
          const pct = h.precipPct;
          const heightPct = pct == null ? 0 : Math.max(2, (pct / max) * 100);
          return (
            <VStack
              key={h.startTime}
              gap={0.5}
              minW="26px"
              title={`${h.label}${h.isCurrentHour ? " (now)" : ""} · ${h.tempF ?? "—"}°F · ${
                pct == null ? "no precipitation data" : `${pct}% chance of rain`
              }${h.windMph != null ? ` · wind ${h.windMph} mph` : ""}${
                h.shortForecast ? ` · ${h.shortForecast}` : ""
              }`}
            >
              <Text fontSize="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
                {pct == null ? "–" : `${pct}`}
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
                  bg={pct == null ? "transparent" : h.isCurrentHour ? "blue.solid" : "blue.300"}
                  borderTopRadius="sm"
                  borderWidth={pct == null ? "1px" : undefined}
                  borderStyle={pct == null ? "dashed" : undefined}
                  borderColor={pct == null ? "border" : undefined}
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
                    is, and they already know that. */}
                {h.isCurrentHour ? "now" : h.label.slice(0, 2)}
              </Text>
              <Text fontSize="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
                {h.tempF != null ? `${h.tempF}°` : ""}
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
                  <Text fontSize="2xs" color="fg.muted">
                    {data.isToday
                      ? "Chance of rain by hour for the rest of today — the marked column is now. Times are ET."
                      : "Chance of rain by hour for the day of this visit. Times are ET."}
                  </Text>
                  <HourlyChart hours={data.hours} />
                  {/* A forecast is a probability for a ~2.5km square, not a
                      promise about one lawn. Say so rather than letting a
                      crisp chart imply certainty. */}
                  <HStack gap={2} align="flex-start">
                    <Text fontSize="2xs" color="fg.muted" flex="1">
                      National Weather Service forecast for this property, as of{" "}
                      {fmtDateTime(data.fetchedAt)}
                      {data.stale ? " (last good reading — the service didn't answer just now)" : ""}. A
                      forecast is a chance, not a guarantee.
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
