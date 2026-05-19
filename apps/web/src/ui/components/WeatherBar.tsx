"use client";

import { useEffect, useRef, useState } from "react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { Cloud, CloudRain, Droplets, Sun, CloudSun, Snowflake, CloudLightning, Wind } from "lucide-react";
import { apiGet } from "@/src/lib/api";

type DayForecast = {
  date: string;
  label?: string;
  high: number;
  low: number;
  description: string;
  icon: string;
  rainChance: number;
  windSpeed: number;
  humidity: number;
};

type WeatherResponse = {
  current: {
    temp: number;
    feelsLike: number;
    description: string;
    icon: string;
    humidity: number;
    windSpeed: number;
  };
  forecast: DayForecast[];
  lat: number;
  lng: number;
};

function WeatherIcon({ icon, size = 14 }: { icon: string; size?: number }) {
  if (icon.startsWith("01")) return <Sun size={size} />;
  if (icon.startsWith("02")) return <CloudSun size={size} />;
  if (icon.startsWith("03") || icon.startsWith("04")) return <Cloud size={size} />;
  if (icon.startsWith("09") || icon.startsWith("10")) return <CloudRain size={size} />;
  if (icon.startsWith("11")) return <CloudLightning size={size} />;
  if (icon.startsWith("13")) return <Snowflake size={size} />;
  if (icon.startsWith("50")) return <Wind size={size} />;
  return <Cloud size={size} />;
}

function dayLabel(date: string, label?: string): string {
  if (label) return label;
  const d = new Date(date + "T12:00:00");
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tmrw";
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function getTheme(icon: string, rainChance: number) {
  if (rainChance >= 50 || icon.startsWith("09") || icon.startsWith("10")) return { bg: "blue.200", border: "blue.400", text: "blue.800", sub: "blue.600" };
  if (icon.startsWith("11")) return { bg: "purple.200", border: "purple.400", text: "purple.800", sub: "purple.600" };
  if (icon.startsWith("13")) return { bg: "gray.200", border: "gray.400", text: "gray.700", sub: "gray.500" };
  if (icon.startsWith("01")) return { bg: "yellow.200", border: "yellow.400", text: "yellow.800", sub: "yellow.600" };
  if (icon.startsWith("02")) return { bg: "orange.200", border: "orange.400", text: "orange.800", sub: "orange.600" };
  if (icon.startsWith("03") || icon.startsWith("04")) return { bg: "gray.200", border: "gray.400", text: "gray.700", sub: "gray.500" };
  if (icon.startsWith("50")) return { bg: "gray.200", border: "gray.400", text: "gray.700", sub: "gray.500" };
  return { bg: "blue.200", border: "blue.400", text: "blue.800", sub: "blue.600" };
}

export default function WeatherBar({ allowGeolocation = false }: { allowGeolocation?: boolean }) {
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(0);
  const [userPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [prevDay, setPrevDay] = useState(0);
  const [sliding, setSliding] = useState(false);
  const slideTimer = useRef<ReturnType<typeof setTimeout>>();
  // Visibility toggle removed — bar is always visible. (To revert, restore the prior
  // `visible` state, localStorage handling, and toggle event listener from git.)

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let latitude: number;
        let longitude: number;
        try {
          // Browser geolocation is only attempted when the caller opts in
          // (allowGeolocation = true). Workers/admins benefit from accurate
          // weather for the job's actual location; logged-out visitors and
          // signed-in clients should NOT see the location permission prompt
          // just for visiting the dashboard — they fall straight through to
          // the IP-based fallback below.
          if (!allowGeolocation) throw new Error("geolocation_skipped");
          const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, maximumAge: 600000, enableHighAccuracy: false });
          });
          latitude = pos.coords.latitude;
          longitude = pos.coords.longitude;
        } catch {
          // Fallback: IP-based location via the API (less accurate but works)
          const ipLoc = await apiGet<{ lat: number; lng: number }>("/api/weather/location");
          latitude = ipLoc.lat;
          longitude = ipLoc.lng;
        }
        const result = await apiGet<WeatherResponse>(`/api/weather?lat=${latitude}&lng=${longitude}`);
        if (!cancelled) {
          setData(result);
          setLoading(false);
          // Cache the latest weather on window so consumers that mount after
          // the fetch completes can read it synchronously.
          (window as any).__seedlingsWeather = { forecast: result.forecast };
          // Broadcast current temp for title bar plus the full forecast so
          // tiles can show tomorrow's inclement-weather indicator.
          window.dispatchEvent(new CustomEvent("seedlings:weather", {
            detail: { temp: result.current.temp, icon: result.current.icon, forecast: result.forecast },
          }));
        }
      } catch (err: any) {
        console.error("[WeatherBar] Failed to load weather:", err);
        if (!cancelled) {
          if (err?.code === 1) setError("Location access denied — enable location in browser settings to see weather.");
          else setError(null);
          setLoading(false);
        }
      }
    }
    void load();
    return () => { cancelled = true; };
    // Re-run when geolocation availability flips (e.g. anonymous visitor
    // signs in as a worker mid-session) so we upgrade IP-based weather to
    // GPS-precise without a page reload.
  }, [allowGeolocation]);

  // Ticker: when activeDay changes, slide up then reset
  useEffect(() => {
    if (activeDay === prevDay) return;
    setSliding(true);
    clearTimeout(slideTimer.current);
    slideTimer.current = setTimeout(() => {
      setSliding(false);
      setPrevDay(activeDay);
    }, 400);
    return () => clearTimeout(slideTimer.current);
  }, [activeDay, prevDay]);

  // Auto-scroll every 4 seconds unless user paused or expanded
  useEffect(() => {
    if (!data || userPaused || expanded) return;
    const count = data.forecast.length;
    if (count <= 1) return;
    const interval = setInterval(() => {
      setActiveDay((prev) => (prev + 1) % count);
    }, 4000);
    return () => clearInterval(interval);
  }, [data, userPaused]);

  if (loading && !data) return (
    <Box px={2} py={1.5} bg="gray.200" borderRadius="md" mb={1} borderWidth="1px" borderColor="gray.400" overflow="hidden" position="relative">
      <style>{`@keyframes weather-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
      <HStack gap={1.5} fontSize="xs" color="gray.500">
        <Cloud size={14} />
        <Text>Loading weather...</Text>
      </HStack>
      <Box
        position="absolute" top="0" left="0" h="full" w="30%"
        style={{
          background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)",
          animation: "weather-shimmer 1.5s ease-in-out infinite",
        }}
      />
    </Box>
  );

  if (error) return (
    <Box px={2} py={1.5} bg="red.200" borderRadius="md" mb={1} borderWidth="1px" borderColor="red.400">
      <Text fontSize="xs" color="red.800">{error}</Text>
    </Box>
  );
  if (!data) return null;

  const { current, forecast } = data;
  const weatherUrl = `https://openweathermap.org/weathermap?basemap=map&cities=false&layer=precipitation&lat=${data.lat}&lon=${data.lng}&zoom=10`;

  function dayProps(i: number) {
    const d = forecast[i];
    const icon = i === 0 ? current.icon : (d?.icon ?? "");
    const rain = d?.rainChance ?? 0;
    const t = getTheme(icon, rain);
    return {
      icon, rain, theme: t,
      label: d ? dayLabel(d.date, d.label) : "Today",
      temp: `${d?.high ?? current.temp}°/${d?.low ?? current.temp}°`,
      desc: i === 0 ? current.description : (d?.description ?? ""),
      wind: i === 0 ? current.windSpeed : (d?.windSpeed ?? 0),
    };
  }

  const theme = dayProps(prevDay).theme;

  function renderDayRow(p: ReturnType<typeof dayProps>) {
    return (
      <HStack gap={1.5} fontSize="xs" color={p.theme.text} whiteSpace="nowrap" overflow="hidden">
        <Text fontWeight="bold" flexShrink={0} w="42px">{p.label}</Text>
        <WeatherIcon icon={p.icon} size={14} />
        <Text fontWeight="semibold" flexShrink={0}>{p.temp}</Text>
        <Text flexShrink={0}>·</Text>
        <Text overflow="hidden" textOverflow="ellipsis">{capitalize(p.desc)}</Text>
        {p.rain > 0 && <><Text flexShrink={0}>·</Text><HStack gap={0.5} flexShrink={0} color={p.rain >= 50 ? p.theme.text : p.theme.sub}><Droplets size={11} /><Text fontWeight={p.rain >= 50 ? "bold" : "normal"}>{p.rain}%</Text></HStack></>}
      </HStack>
    );
  }

  // "Now" cell experiment — shows current temp on the left of the bar.
  // To revert: delete this NowCell and the two HStack wrappers below that include it.
  const NowCell = ({ borderColor, sub, text, hasRightBorder = true }: { borderColor: string; sub: string; text: string; hasRightBorder?: boolean }) => (
    <Box
      flexShrink={0}
      px={2}
      py={1.5}
      borderRightWidth={hasRightBorder ? "1px" : 0}
      borderColor={borderColor}
      display="flex"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      minW="56px"
    >
      <Text fontSize="2xs" color={sub} lineHeight="1" fontWeight="medium" textTransform="uppercase">Now</Text>
      <Text fontSize="sm" fontWeight="bold" color={text} lineHeight="1.2">{current.temp}°</Text>
    </Box>
  );

  if (expanded) {
    return (
      <Box borderRadius="md" mb={1} borderWidth="1px" borderColor="gray.400" overflow="hidden" cursor="pointer" onClick={() => setExpanded(false)}>
        <HStack alignItems="stretch" gap={0}>
          <NowCell borderColor={theme.border} sub={theme.sub} text={theme.text} />
          <Box flex="1" minW={0}>
            {forecast.map((_, i) => {
              const p = dayProps(i);
              return (
                <Box key={i} px={2} py={1.5} bg={p.theme.bg} borderBottom={i < forecast.length - 1 ? "1px solid" : undefined} borderColor={p.theme.border}>
                  {renderDayRow(p)}
                </Box>
              );
            })}
            <HStack px={2} py={1.5} bg="gray.100" justify="center">
              <Text fontSize="xs" color="blue.600" cursor="pointer" _hover={{ textDecoration: "underline" }} onClick={(e) => { e.stopPropagation(); window.open(weatherUrl, "_blank"); }}>
                View full forecast →
              </Text>
            </HStack>
          </Box>
        </HStack>
      </Box>
    );
  }

  const ROW_H = 20;
  const prev = dayProps(prevDay);
  const next = dayProps(activeDay);

  return (
    <Box
      borderRadius="md" mb={1} cursor="pointer"
      bg={theme.bg} borderWidth="1px" borderColor={theme.border}
      transition="background 0.3s ease, border-color 0.3s ease"
      overflow="hidden"
      style={{ height: ROW_H + 12 }}
      onClick={() => setExpanded(true)}
    >
      <HStack alignItems="stretch" gap={0} h="full">
        <NowCell borderColor={theme.border} sub={theme.sub} text={theme.text} />
        <Box flex="1" minW={0} overflow="hidden">
          <Box
            px={2} py={1.5}
            style={{
              transform: sliding ? `translateY(-${ROW_H + 12}px)` : "translateY(0)",
              transition: sliding ? "transform 0.4s ease-in-out" : "none",
            }}
          >
            {renderDayRow(prev)}
            <Box mt={1.5}>{renderDayRow(next)}</Box>
          </Box>
        </Box>
      </HStack>
    </Box>
  );
}
