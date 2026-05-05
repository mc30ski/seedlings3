"use client";

import { Box, HStack, Text } from "@chakra-ui/react";
import { CloudRain, CloudLightning, Snowflake, Wind } from "lucide-react";
import { useTomorrowWeather, type TomorrowWeather } from "@/src/lib/useTomorrowWeather";

function themeFor(cat: TomorrowWeather["category"]) {
  switch (cat) {
    case "rain": return { bg: "blue.100", border: "blue.300", text: "blue.800", Icon: CloudRain };
    case "thunderstorm": return { bg: "purple.100", border: "purple.300", text: "purple.800", Icon: CloudLightning };
    case "snow": return { bg: "gray.100", border: "gray.400", text: "gray.800", Icon: Snowflake };
    case "wind": return { bg: "yellow.100", border: "yellow.300", text: "yellow.800", Icon: Wind };
    default: return null;
  }
}

function defaultMessage(w: TomorrowWeather): string {
  const desc = w.description ? w.description.charAt(0).toUpperCase() + w.description.slice(1) : "";
  if (w.category === "rain") {
    if (w.rainChance > 0) return `${desc || "Rain"} tomorrow · ${w.rainChance}%`;
    return desc || "Rain tomorrow";
  }
  if (w.category === "thunderstorm") return desc || "Thunderstorms tomorrow";
  if (w.category === "snow") return desc || "Snow tomorrow";
  if (w.category === "wind") return `Windy tomorrow · ${Math.round(w.windSpeed)} mph`;
  return desc;
}

type Props = {
  // Show the chip even for borderline conditions like wind, not just rain/snow/storms.
  includeWind?: boolean;
  size?: "sm" | "md";
  // When provided, overrides the default copy.
  prefix?: string;
};

export default function TomorrowWeatherWarning({ includeWind = false, size = "sm", prefix }: Props) {
  const w = useTomorrowWeather();
  if (!w) return null;
  const show = w.inclement || (includeWind && w.category === "wind");
  if (!show) return null;
  const t = themeFor(w.category);
  if (!t) return null;
  const { Icon } = t;
  const fontSize = size === "md" ? "sm" : "xs";
  const iconSize = size === "md" ? 14 : 12;
  const px = size === "md" ? 2.5 : 2;
  const py = size === "md" ? 1 : 0.5;
  const message = prefix ? `${prefix} · ${defaultMessage(w)}` : defaultMessage(w);
  return (
    <Box
      display="inline-flex"
      bg={t.bg}
      borderWidth="1px"
      borderColor={t.border}
      color={t.text}
      borderRadius="full"
      px={px}
      py={py}
    >
      <HStack gap={1} fontSize={fontSize} fontWeight="medium">
        <Icon size={iconSize} />
        <Text>{message}</Text>
      </HStack>
    </Box>
  );
}
