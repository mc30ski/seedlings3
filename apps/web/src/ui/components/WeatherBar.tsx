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
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
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

export default function WeatherBar() {
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState(0);
  const [userPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [prevDay, setPrevDay] = useState(0);
  const [sliding, setSliding] = useState(false);
  const slideTimer = useRef<ReturnType<typeof setTimeout>>();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem("seedlings_hideWeatherBar") === "1") setVisible(false); } catch {}
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { visible: v } = (e as CustomEvent).detail || {};
      setVisible(v);
    };
    window.addEventListener("seedlings:weatherBarToggle", handler);
    return () => window.removeEventListener("seedlings:weatherBarToggle", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let latitude: number;
        let longitude: number;
        try {
          // Try browser geolocation first
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
          // Broadcast current temp for title bar
          window.dispatchEvent(new CustomEvent("seedlings:weather", { detail: { temp: result.current.temp, icon: result.current.icon } }));
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
  }, []);

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

  if (!visible) return null;

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
        <Text fontWeight="bold" flexShrink={0} w="65px">{p.label}</Text>
        <WeatherIcon icon={p.icon} size={14} />
        <Text fontWeight="semibold" flexShrink={0}>{p.temp}</Text>
        <Text flexShrink={0}>·</Text>
        <Text overflow="hidden" textOverflow="ellipsis">{capitalize(p.desc)}</Text>
        {p.rain > 0 && <><Text flexShrink={0}>·</Text><HStack gap={0.5} flexShrink={0} color={p.rain >= 50 ? p.theme.text : p.theme.sub}><Droplets size={11} /><Text fontWeight={p.rain >= 50 ? "bold" : "normal"}>{p.rain}%</Text></HStack></>}
        {p.wind > 0 && <><Text flexShrink={0}>·</Text><Text color={p.theme.sub} flexShrink={0}>{p.wind}mph</Text></>}
      </HStack>
    );
  }

  if (expanded) {
    return (
      <Box borderRadius="md" mb={1} borderWidth="1px" borderColor="gray.400" overflow="hidden" cursor="pointer" onClick={() => setExpanded(false)}>
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
  );
}
