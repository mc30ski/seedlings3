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
  const [userPaused, setUserPaused] = useState(false);
  const touchStartX = useRef(0);

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
        console.log("[WeatherBar] Got weather data:", result);
        if (!cancelled) { setData(result); setLoading(false); }
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

  // Auto-scroll every 4 seconds unless user swiped
  useEffect(() => {
    if (!data || userPaused) return;
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

  const activeIcon = activeDay === 0 ? current.icon : (forecast[activeDay]?.icon ?? "");
  const activeRain = activeDay === 0 ? (forecast[0]?.rainChance ?? 0) : (forecast[activeDay]?.rainChance ?? 0);
  const theme = getTheme(activeIcon, activeRain);

  const day = forecast[activeDay];
  const label = day ? dayLabel(day.date, day.label) : "Today";

  return (
    <Box
      px={2} py={1.5} borderRadius="md" mb={1} cursor="pointer"
      bg={theme.bg} borderWidth="1px" borderColor={theme.border}
      transition="background 0.3s ease, border-color 0.3s ease"
      onClick={() => window.open(weatherUrl, "_blank")}
      onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - touchStartX.current;
        if (Math.abs(dx) > 40) {
          e.stopPropagation();
          setUserPaused(true);
          const count = forecast.length;
          if (dx < 0) setActiveDay((prev) => Math.min(prev + 1, count - 1));
          else setActiveDay((prev) => Math.max(prev - 1, 0));
        }
      }}
    >
      <HStack gap={1.5} fontSize="xs" color={theme.text} whiteSpace="nowrap" overflow="hidden">
        <Text fontWeight="bold" flexShrink={0}>{label}</Text>
        <Text flexShrink={0}>·</Text>
        <WeatherIcon icon={activeIcon} size={14} />
        {activeDay === 0 ? (
          <>
            <Text fontWeight="semibold" flexShrink={0}>{current.temp}°F</Text>
            <Text flexShrink={0}>·</Text>
            <Text overflow="hidden" textOverflow="ellipsis">{capitalize(current.description)}</Text>
            {current.feelsLike !== current.temp && <><Text flexShrink={0}>·</Text><Text color={theme.sub} flexShrink={0}>Feels {current.feelsLike}°</Text></>}
          </>
        ) : day ? (
          <>
            <Text fontWeight="semibold" flexShrink={0}>{day.high}°/{day.low}°</Text>
            <Text flexShrink={0}>·</Text>
            <Text overflow="hidden" textOverflow="ellipsis">{capitalize(day.description)}</Text>
          </>
        ) : null}
        {(() => {
          const rain = activeDay === 0 ? (forecast[0]?.rainChance ?? 0) : (day?.rainChance ?? 0);
          if (rain <= 0) return null;
          return <><Text flexShrink={0}>·</Text><HStack gap={0.5} flexShrink={0} color={rain >= 50 ? theme.text : theme.sub}><Droplets size={11} /><Text fontWeight={rain >= 50 ? "bold" : "normal"}>{rain}%</Text></HStack></>;
        })()}
        {(() => {
          const wind = activeDay === 0 ? current.windSpeed : (day?.windSpeed ?? 0);
          if (wind <= 0) return null;
          return <><Text flexShrink={0}>·</Text><Text color={theme.sub} flexShrink={0}>{wind}mph</Text></>;
        })()}
      </HStack>
    </Box>
  );
}
