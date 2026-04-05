"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { List, Maximize2 } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { type WorkerOccurrence } from "@/src/lib/types";
import { fmtDate, bizDateKey, clientLabel } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";
import { openEventSearch } from "@/src/lib/bus";
import SearchWithClear from "@/src/ui/components/SearchWithClear";

type Props = {
  myId?: string;
  showAll?: boolean;
  forAdmin?: boolean;
};

const DISMISSED_KEY = "seedlings_reminders_dismissed";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    // Clean out old days — only keep today's dismissals
    if (data.date !== today) {
      localStorage.removeItem(DISMISSED_KEY);
      return new Set();
    }
    return new Set(data.ids ?? []);
  } catch { return new Set(); }
}

function saveDismissed(ids: Set<string>) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify({ date: today, ids: Array.from(ids) }));
  } catch {}
}

export default function RemindersTab({ myId, showAll, forAdmin }: Props) {
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [compact, setCompact] = useState(true);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  function dismissReminder(occId: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(occId);
      saveDismissed(next);
      return next;
    });
  }

  function undismissAll() {
    setDismissed(new Set());
    saveDismissed(new Set());
  }

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

  const today = bizDateKey(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = bizDateKey(tomorrowDate);

  const myItems = useMemo(() => {
    let rows = showAll
      ? items.filter((occ) => (occ.assignees ?? []).length > 0)
      : myId
      ? items.filter((occ) => (occ.assignees ?? []).some((a) => a.userId === myId))
      : items;

    // Text search
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((occ) =>
        [
          occ.job?.property?.displayName,
          occ.job?.property?.street1,
          occ.job?.property?.city,
          occ.job?.property?.state,
          occ.job?.property?.client?.displayName,
          occ.status,
          occ.notes,
          ...(occ.assignees ?? []).map((a) => a.user?.displayName ?? a.user?.email),
        ]
          .filter(Boolean)
          .some((s) => (s as string).toLowerCase().includes(qlc))
      );
    }
    return rows;
  }, [items, myId, showAll, q]);

  const notDismissed = (occ: WorkerOccurrence) => !dismissed.has(occ.id);

  const overdue = myItems.filter((occ) => {
    if (occ.status !== "SCHEDULED") return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) < today;
  }).filter(notDismissed);

  const todayJobs = myItems.filter((occ) => {
    if (occ.status !== "SCHEDULED" && occ.status !== "IN_PROGRESS") return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) === today;
  }).filter(notDismissed);

  const tomorrowJobs = myItems.filter((occ) => {
    if (occ.status !== "SCHEDULED") return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) === tomorrow;
  }).filter(notDismissed);

  const pendingPayment = myItems.filter((occ) => occ.status === "PENDING_PAYMENT").filter(notDismissed);

  const estimatesReady = myItems.filter((occ) =>
    occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate)
  ).filter(notDismissed);

  const showRoutePlanReminder = !dismissed.has("__route_plan__") && !forAdmin;
  const hasReminders = showRoutePlanReminder || overdue.length > 0 || todayJobs.length > 0 || tomorrowJobs.length > 0 || pendingPayment.length > 0 || estimatesReady.length > 0;
  const hasDismissed = dismissed.size > 0;

  if (loading) {
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }

  function toggleCard(id: string) {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <Box w="full" pb={8}>
      <HStack mb={3} gap={2}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          placeholder="Search reminders…"
          inputId="reminders-search"
        />
        <Button
          size="sm"
          variant={compact ? "solid" : "ghost"}
          px="2"
          onClick={() => { setCompact(!compact); setExpandedCards(new Set()); }}
          css={compact ? {
            background: "var(--chakra-colors-gray-200)",
            color: "var(--chakra-colors-gray-700)",
          } : undefined}
        >
          {compact ? <Maximize2 size={14} /> : <List size={14} />}
        </Button>
      </HStack>

      {!hasReminders && (
        <Box textAlign="center" py={10}>
          <Text fontSize="lg" fontWeight="semibold" color="green.600">All caught up!</Text>
          <Text fontSize="sm" color="fg.muted" mt={1}>
            {hasDismissed ? `No reminders — ${dismissed.size} dismissed today.` : "No reminders right now."}
          </Text>
          {hasDismissed && (
            <Button size="sm" variant="ghost" mt={2} onClick={undismissAll}>
              Show dismissed
            </Button>
          )}
        </Box>
      )}

      {/* Route planning reminder — always at top */}
      {showRoutePlanReminder && (
        <Box mb={4}>
          <Card.Root variant="outline" borderColor="blue.300" bg="blue.50">
            <Card.Body py="3" px="4">
              <HStack justify="space-between" align="center">
                <VStack align="start" gap={0.5} flex="1">
                  <Text fontSize="sm" fontWeight="semibold" color="blue.700">
                    Plan tomorrow's route
                  </Text>
                  <Text fontSize="xs" color="blue.600">
                    Review and optimize your route for tomorrow to make the most of your day.
                  </Text>
                </VStack>
                <HStack gap={2} flexShrink={0}>
                  <Button
                    size="sm"
                    colorPalette="blue"
                    variant="solid"
                    onClick={() => {
                      // Navigate to Routes tab
                      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes" } }));
                    }}
                  >
                    Plan Route
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={() => dismissReminder("__route_plan__")}
                  >
                    Dismiss
                  </Button>
                </HStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        </Box>
      )}

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
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
        />
      )}

      {todayJobs.length > 0 && (
        <Section
          title="Today"
          subtitle="Jobs scheduled for today — confirm with client"
          color="blue.600"
          items={todayJobs}
          badge={() => <Badge colorPalette="blue" variant="solid" fontSize="xs" borderRadius="full" px="2">Today</Badge>}
          message="Confirm with the client that the job is still on for today"
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
        />
      )}

      {tomorrowJobs.length > 0 && (
        <Section
          title="Tomorrow"
          subtitle="Jobs scheduled for tomorrow — reach out to confirm"
          color="teal.600"
          items={tomorrowJobs}
          badge={() => <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">Tomorrow</Badge>}
          message="Contact the client to confirm they want the job done tomorrow"
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
        />
      )}

      {pendingPayment.length > 0 && (
        <Section
          title="Pending Payment"
          subtitle="These jobs are complete but payment hasn't been collected"
          color="orange.600"
          items={pendingPayment}
          badge={() => <Badge colorPalette="orange" variant="solid" fontSize="xs" borderRadius="full" px="2">Awaiting payment</Badge>}
          message="Collect payment from the client"
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
        />
      )}

      {estimatesReady.length > 0 && (
        <Section
          title="Estimates Ready"
          subtitle="Completed estimates awaiting your review"
          color="purple.600"
          items={estimatesReady}
          badge={() => <Badge colorPalette="purple" variant="solid" fontSize="xs" borderRadius="full" px="2">Review needed</Badge>}
          message="Accept or reject this estimate"
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
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
  forAdmin,
  compact,
  expandedCards,
  toggleCard,
}: {
  title: string;
  subtitle: string;
  color: string;
  items: WorkerOccurrence[];
  badge: (occ: WorkerOccurrence) => React.ReactNode;
  message: string;
  showAssignees?: boolean;
  forAdmin?: boolean;
  compact: boolean;
  expandedCards: Set<string>;
  toggleCard: (id: string) => void;
}) {
  return (
    <Box mb={5}>
      <Text fontSize="xs" fontWeight="semibold" color={color} mb={1} px={1} textTransform="uppercase" letterSpacing="wide">
        {title} ({items.length})
      </Text>
      <Text fontSize="xs" color="fg.muted" mb={2} px={1}>{subtitle}</Text>
      <VStack align="stretch" gap={2}>
        {items.map((occ) => {
          const isExpanded = !compact || expandedCards.has(occ.id);
          return (
            <Card.Root
              key={occ.id}
              variant="outline"
              css={compact ? { cursor: "pointer", "& a, & button": { pointerEvents: "auto" } } : undefined}
              onClick={() => { if (compact) toggleCard(occ.id); }}
            >
              {isExpanded && (
                <Box px="4" pt="3" pb="0">
                  <Button
                    size="xs"
                    variant="solid"
                    colorPalette="blue"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEventSearch(
                        "remindersToJobsTabSearch",
                        occ.job?.property?.displayName ?? "",
                        !!forAdmin,
                        `${occ.id}|${occ.startAt ?? ""}`,
                      );
                    }}
                  >
                    View in Jobs
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={(e) => { e.stopPropagation(); dismissReminder(occ.id); }}
                  >
                    Dismiss
                  </Button>
                </Box>
              )}
              <Card.Body py="3" px="4" pt={isExpanded ? "2" : "3"}>
                <HStack justify="space-between" align="start" gap={3}>
                  <VStack align="start" gap={1} flex="1" minW={0}>
                    <Text fontSize={isExpanded ? "sm" : "sm"} fontWeight="medium">
                      {occ.job?.property?.displayName}
                      {occ.job?.property?.client?.displayName && (
                        <> — {clientLabel(occ.job.property.client.displayName)}</>
                      )}
                    </Text>
                    {isExpanded && (
                      <>
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
                      </>
                    )}
                    {!isExpanded && (
                      <HStack gap={2} fontSize="xs" justify="space-between" w="full">
                        <HStack gap={2} flexWrap="wrap" flex="1" minW={0}>
                          {badge(occ)}
                          {occ.startAt && <Text color="fg.muted">{fmtDate(occ.startAt)}</Text>}
                          {occ.price != null && (
                            <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                              ${occ.price.toFixed(2)}
                            </Badge>
                          )}
                          {showAssignees && (occ.assignees ?? []).length > 0 && (
                            <Text color="teal.600">
                              {(occ.assignees ?? []).map((a) => a.user?.displayName ?? a.user?.email ?? a.userId).join(", ")}
                            </Text>
                          )}
                        </HStack>
                        <Button
                          size="xs"
                          variant="ghost"
                          colorPalette="gray"
                          flexShrink={0}
                          onClick={(e) => { e.stopPropagation(); dismissReminder(occ.id); }}
                        >
                          Dismiss
                        </Button>
                      </HStack>
                    )}
                  </VStack>
                  {isExpanded && (
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
                  )}
                </HStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>
    </Box>
  );
}
