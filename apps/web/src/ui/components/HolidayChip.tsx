"use client";

import { Badge, HStack } from "@chakra-ui/react";
import { CalendarOff } from "lucide-react";
import { getUSHoliday } from "@/src/lib/holidays";

/**
 * Small chip rendered next to a date label when that date is a US federal
 * holiday. Lets workers see at a glance that they might want to adjust
 * service for that day (clients home / not home, business closures, etc.).
 *
 * Renders nothing when the date isn't a holiday — safe to drop into any
 * date header without conditional wrapping.
 *
 * `dateKey` is a "YYYY-MM-DD" business-date-key string (the same shape
 * the JobsTab groups by). Pass `group.key` directly.
 */
export default function HolidayChip({ dateKey }: { dateKey: string }) {
  const holiday = getUSHoliday(dateKey);
  if (!holiday) return null;
  return (
    <Badge
      size="sm"
      colorPalette="orange"
      variant="subtle"
      borderRadius="full"
      px="2"
      fontSize="2xs"
      lineHeight="1"
      title={
        holiday.observed
          ? `Federal holiday observed on this date (${holiday.name})`
          : `Federal holiday: ${holiday.name}`
      }
    >
      <HStack gap="1" align="center">
        <CalendarOff size={10} />
        <span>{holiday.name}</span>
      </HStack>
    </Badge>
  );
}
