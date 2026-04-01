"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { type WorkerOccurrence } from "@/src/lib/types";
import { fmtDate, bizDateKey, clientLabel } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";

type Props = {
  myId?: string;
  /** When true, show reminders for all workers (admin mode) */
  showAll?: boolean;
};

export default function RemindersTab({ myId, showAll }: Props) {
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    async function load() {
      try {
        const list = await apiGet<WorkerOccurrence[]>("/api/occurrences");
        setItems(Array.isArray(list) ? list : []);
      } catch {
        setItems([]);
      }
      setLoading(false);
    }
    void load();
  }, []);

  if (loading) {
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }

  const today = bizDateKey(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = bizDateKey(tomorrowDate);

  // Filter: specific worker, all workers (assigned only), or just mine
  const myItems = showAll
    ? items.filter((occ) => (occ.assignees ?? []).length > 0)
    : myId
    ? items.filter((occ) => (occ.assignees ?? []).some((a) => a.userId === myId))
    : items;

  // Overdue: scheduled, start date before today
  const overdue = myItems.filter((occ) => {
    if (occ.status !== "SCHEDULED") return false;
    if (!occ.startAt) return false;
    const d = bizDateKey(occ.startAt);
    return d < today;
  });

  // Today's jobs: scheduled or in progress, start date is today
  const todayJobs = myItems.filter((occ) => {
    if (occ.status !== "SCHEDULED" && occ.status !== "IN_PROGRESS") return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) === today;
  });

  // Tomorrow's jobs: scheduled, start date is tomorrow
  const tomorrowJobs = myItems.filter((occ) => {
    if (occ.status !== "SCHEDULED") return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) === tomorrow;
  });

  // Pending payment
  const pendingPayment = myItems.filter((occ) => occ.status === "PENDING_PAYMENT");

  // Estimates awaiting action
  const estimatesReady = myItems.filter((occ) =>
    occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate)
  );

  const hasReminders = overdue.length > 0 || todayJobs.length > 0 || tomorrowJobs.length > 0 || pendingPayment.length > 0 || estimatesReady.length > 0;

  return (
    <Box w="full" pb={8}>
      {!hasReminders && (
        <Box textAlign="center" py={10}>
          <Text fontSize="lg" fontWeight="semibold" color="green.600">All caught up!</Text>
          <Text fontSize="sm" color="fg.muted" mt={1}>No reminders right now.</Text>
        </Box>
      )}

      {/* Overdue */}
      {overdue.length > 0 && (
        <Section
          title="Overdue"
          subtitle="These jobs are past their scheduled date"
          color="red.600"
          items={overdue}
          badge={(occ) => {
            const d = occ.startAt ? bizDateKey(occ.startAt) : null;
            const daysLate = d ? Math.round((new Date(today + "T12:00:00Z").getTime() - new Date(d + "T12:00:00Z").getTime()) / 86400000) : 0;
            return <Badge colorPalette="red" variant="solid" fontSize="xs" borderRadius="full" px="2">{daysLate} day{daysLate !== 1 ? "s" : ""} overdue</Badge>;
          }}
          message="Contact the client to reschedule or complete this job"
          showAssignees={showAll}
        />
      )}

      {/* Today */}
      {todayJobs.length > 0 && (
        <Section
          title="Today"
          subtitle="Jobs scheduled for today — confirm with client"
          color="blue.600"
          items={todayJobs}
          badge={() => <Badge colorPalette="blue" variant="solid" fontSize="xs" borderRadius="full" px="2">Today</Badge>}
          message="Confirm with the client that the job is still on for today"
          showAssignees={showAll}
        />
      )}

      {/* Tomorrow */}
      {tomorrowJobs.length > 0 && (
        <Section
          title="Tomorrow"
          subtitle="Jobs scheduled for tomorrow — reach out to confirm"
          color="teal.600"
          items={tomorrowJobs}
          badge={() => <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">Tomorrow</Badge>}
          message="Contact the client to confirm they want the job done tomorrow"
          showAssignees={showAll}
        />
      )}

      {/* Pending payment */}
      {pendingPayment.length > 0 && (
        <Section
          title="Pending Payment"
          subtitle="These jobs are complete but payment hasn't been collected"
          color="orange.600"
          items={pendingPayment}
          badge={() => <Badge colorPalette="orange" variant="solid" fontSize="xs" borderRadius="full" px="2">Awaiting payment</Badge>}
          message="Collect payment from the client"
          showAssignees={showAll}
        />
      )}

      {/* Estimates ready for review */}
      {estimatesReady.length > 0 && (
        <Section
          title="Estimates Ready"
          subtitle="Completed estimates awaiting your review"
          color="purple.600"
          items={estimatesReady}
          badge={() => <Badge colorPalette="purple" variant="solid" fontSize="xs" borderRadius="full" px="2">Review needed</Badge>}
          message="Accept or reject this estimate"
          showAssignees={showAll}
        />
      )}
    </Box>
  );
}

function Section({
  title,
  subtitle,
  color,
  items,
  badge,
  message,
  showAssignees,
}: {
  title: string;
  subtitle: string;
  color: string;
  items: WorkerOccurrence[];
  badge: (occ: WorkerOccurrence) => React.ReactNode;
  message: string;
  showAssignees?: boolean;
}) {
  return (
    <Box mb={5}>
      <Text fontSize="xs" fontWeight="semibold" color={color} mb={1} px={1} textTransform="uppercase" letterSpacing="wide">
        {title}
      </Text>
      <Text fontSize="xs" color="fg.muted" mb={2} px={1}>{subtitle}</Text>
      <VStack align="stretch" gap={2}>
        {items.map((occ) => (
          <Card.Root key={occ.id} variant="outline">
            <Card.Body py="3" px="4">
              <HStack justify="space-between" align="start" gap={3}>
                <VStack align="start" gap={1} flex="1" minW={0}>
                  <Text fontSize="sm" fontWeight="medium">
                    {occ.job?.property?.displayName}
                    {occ.job?.property?.client?.displayName && (
                      <> — {clientLabel(occ.job.property.client.displayName)}</>
                    )}
                  </Text>
                  <Box fontSize="xs">
                    <MapLink address={[
                      occ.job?.property?.street1,
                      occ.job?.property?.city,
                      occ.job?.property?.state,
                    ].filter(Boolean).join(", ")} />
                  </Box>
                  {showAssignees && (occ.assignees ?? []).length > 0 && (
                    <Text fontSize="xs" color="teal.600">
                      {(occ.assignees ?? []).map((a) => a.user?.displayName ?? a.user?.email ?? a.userId).join(", ")}
                    </Text>
                  )}
                  <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                    {message}
                  </Text>
                </VStack>
                <VStack align="end" gap={1} flexShrink={0}>
                  {badge(occ)}
                  {occ.startAt && (
                    <Text fontSize="xs" color="fg.muted">{fmtDate(occ.startAt)}</Text>
                  )}
                  {occ.price != null && (
                    <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                      ${occ.price.toFixed(2)}
                    </Badge>
                  )}
                </VStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>
    </Box>
  );
}
