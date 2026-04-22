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

export default function WeatherBar() {
  const [data, setData] = useState<WeatherResponse | null>(null);
  const [error, setError] = useState(false);
  const [activeDay, setActiveDay] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 600000 });
        });
        const { latitude, longitude } = pos.coords;
        const result = await apiGet<WeatherResponse>(`/api/weather?lat=${latitude}&lng=${longitude}`);
        if (!cancelled) setData(result);
      } catch (err) {
        console.error("[WeatherBar] Failed to load weather:", err);
        if (!cancelled) setError(true);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  // Auto-scroll through tabs every 5 seconds unless user clicked a tab
  useEffect(() => {
    if (!data || userPaused) return;
    const count = data.forecast.length;
    if (count <= 1) return;
    const interval = setInterval(() => {
      setActiveDay((prev) => (prev + 1) % count);
    }, 5000);
    return () => clearInterval(interval);
  }, [data, userPaused]);

  if (error || !data) return null;

  const { current, forecast } = data;
  const weatherUrl = `https://openweathermap.org/weathermap?basemap=map&cities=false&layer=precipitation&lat=${data.lat}&lon=${data.lng}&zoom=10`;

  // Color based on active day's conditions
  const activeIcon = activeDay === 0 ? current.icon : (forecast[activeDay]?.icon ?? "");
  const activeRain = activeDay === 0 ? (forecast[0]?.rainChance ?? 0) : (forecast[activeDay]?.rainChance ?? 0);
  const theme = (() => {
    // Rain/storm takes priority
    if (activeRain >= 50 || activeIcon.startsWith("09") || activeIcon.startsWith("10")) return { bg: "blue.100", hover: "blue.200", text: "blue.800", sub: "blue.600", tab: "blue.600", tabActive: "blue.800" };
    if (activeIcon.startsWith("11")) return { bg: "purple.100", hover: "purple.200", text: "purple.800", sub: "purple.600", tab: "purple.600", tabActive: "purple.800" };
    if (activeIcon.startsWith("13")) return { bg: "gray.100", hover: "gray.200", text: "gray.700", sub: "gray.500", tab: "gray.500", tabActive: "gray.700" };
    // Clear/sunny
    if (activeIcon.startsWith("01")) return { bg: "yellow.50", hover: "yellow.100", text: "yellow.800", sub: "yellow.600", tab: "yellow.600", tabActive: "yellow.800" };
    // Partly cloudy
    if (activeIcon.startsWith("02")) return { bg: "orange.50", hover: "orange.100", text: "orange.800", sub: "orange.500", tab: "orange.500", tabActive: "orange.800" };
    // Cloudy/overcast
    if (activeIcon.startsWith("03") || activeIcon.startsWith("04")) return { bg: "gray.100", hover: "gray.200", text: "gray.700", sub: "gray.500", tab: "gray.500", tabActive: "gray.700" };
    // Mist/fog
    if (activeIcon.startsWith("50")) return { bg: "gray.100", hover: "gray.200", text: "gray.600", sub: "gray.400", tab: "gray.400", tabActive: "gray.700" };
    return { bg: "blue.50", hover: "blue.100", text: "blue.700", sub: "blue.500", tab: "blue.500", tabActive: "blue.800" };
  })();

  return (
    <Box
      px={2} py={1} bg={theme.bg} borderRadius="md" mb={1} cursor="pointer"
      onClick={() => window.open(weatherUrl, "_blank")}
      _hover={{ bg: theme.hover }}
      transition="background 0.3s ease"
    >
      {/* Day tabs */}
      <HStack gap={0} mb={0.5}>
        {forecast.map((day, i) => (
          <Box
            key={day.date}
            px={2}
            py={0.5}
            fontSize="2xs"
            fontWeight={activeDay === i ? "bold" : "normal"}
            color={activeDay === i ? theme.tabActive : theme.tab}
            borderBottom={activeDay === i ? "2px solid" : "2px solid transparent"}
            borderColor={activeDay === i ? theme.tab : "transparent"}
            cursor="pointer"
            onClick={(e) => { e.stopPropagation(); setActiveDay(i); setUserPaused(true); }}
            _hover={{ color: theme.tabActive }}
          >
            {dayLabel(day.date, day.label)}
          </Box>
        ))}
      </HStack>
      {/* Weather details */}
      {(() => {
        if (activeDay === 0 && current) {
          // Today: show current conditions + today's forecast rain chance
          const todayForecast = forecast[0];
          return (
            <HStack gap={1.5} fontSize="xs" color={theme.text} whiteSpace="nowrap" overflow="hidden">
              <WeatherIcon icon={current.icon} size={14} />
              <Text fontWeight="semibold">{current.temp}°F</Text>
              <Text>·</Text>
              <Text>{capitalize(current.description)}</Text>
              {current.feelsLike !== current.temp && <><Text>·</Text><Text color={theme.sub}>Feels {current.feelsLike}°</Text></>}
              {todayForecast && todayForecast.rainChance > 0 && <><Text>·</Text><HStack gap={0.5} color={todayForecast.rainChance >= 50 ? theme.text : theme.sub}><Droplets size={11} /><Text fontWeight={todayForecast.rainChance >= 50 ? "semibold" : "normal"}>{todayForecast.rainChance}%</Text></HStack></>}
              {current.windSpeed > 0 && <><Text>·</Text><Text color={theme.sub}>{current.windSpeed}mph</Text></>}
            </HStack>
          );
        }
        // Tomorrow / day after: show forecast
        const day = forecast[activeDay];
        if (!day) return null;
        return (
          <HStack gap={1.5} fontSize="xs" color={theme.text} whiteSpace="nowrap" overflow="hidden">
            <WeatherIcon icon={day.icon} size={14} />
            <Text fontWeight="semibold">{day.high}°/{day.low}°</Text>
            <Text>·</Text>
            <Text>{capitalize(day.description)}</Text>
            {day.rainChance > 0 && <><Text>·</Text><HStack gap={0.5} color={day.rainChance >= 50 ? theme.text : theme.sub}><Droplets size={11} /><Text fontWeight={day.rainChance >= 50 ? "semibold" : "normal"}>{day.rainChance}%</Text></HStack></>}
            {day.windSpeed > 0 && <><Text>·</Text><Text color={theme.sub}>{day.windSpeed}mph</Text></>}
          </HStack>
        );
      })()}
    </Box>
  );
}
