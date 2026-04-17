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
import { Bell, Copy, List, Mail, Maximize2, MessageCircle } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { type Me, type WorkerOccurrence } from "@/src/lib/types";
import { fmtDate, bizDateKey, clientLabel } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import { openEventSearch } from "@/src/lib/bus";
import SearchWithClear from "@/src/ui/components/SearchWithClear";

type Props = {
  myId?: string;
  me?: Me | null;
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
  // Notify the planning badge in the title bar
  window.dispatchEvent(new CustomEvent("seedlings3:planning-changed"));
}

function contactName(occ: WorkerOccurrence): string {
  const poc = occ.job?.property?.pointOfContact
    ?? occ.linkedOccurrence?.job?.property?.pointOfContact;
  if (poc?.firstName) return poc.firstName;
  const clientDisplay = occ.job?.property?.client?.displayName
    ?? occ.linkedOccurrence?.job?.property?.client?.displayName;
  if (clientDisplay) return `${clientDisplay}`;
  return "there";
}

export default function RemindersTab({ myId, me, showAll, forAdmin }: Props) {
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
    // Filter out ghost cards (pinned/reminder ghosts from the API) — they're for the Jobs tab
    let rows = items.filter((occ: any) => !occ._isReminderGhost && !occ._isPinnedGhost);

    rows = showAll
      ? rows.filter((occ) => (occ.assignees ?? []).length > 0)
      : myId
      ? rows.filter((occ) => (occ.assignees ?? []).some((a) => a.userId === myId))
      : rows;

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

  const overdueExclude = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
  const overdue = myItems.filter((occ) => {
    if (!occ.startAt) return false;
    if (overdueExclude.has(occ.status)) return false;
    return bizDateKey(occ.startAt) < today;
  }).filter(notDismissed);

  const activeStatuses = new Set(["SCHEDULED", "IN_PROGRESS", "ACCEPTED"]);
  const upcomingStatuses = new Set(["SCHEDULED", "ACCEPTED"]);

  const todayJobs = myItems.filter((occ) => {
    if (!activeStatuses.has(occ.status)) return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) === today;
  }).filter(notDismissed);

  const tomorrowJobs = myItems.filter((occ) => {
    if (!upcomingStatuses.has(occ.status)) return false;
    if (!occ.startAt) return false;
    return bizDateKey(occ.startAt) === tomorrow;
  }).filter(notDismissed);

  const pendingPayment = myItems.filter((occ) => occ.status === "PENDING_PAYMENT").filter(notDismissed);

  const estimatesReady = myItems.filter((occ) =>
    occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate)
  ).filter(notDismissed);

  // Follow-ups — occurrences with reminders due today or earlier (filtered to current worker)
  const followUps = useMemo(() => {
    if (forAdmin) return [];
    return myItems.filter((occ) => {
      if (!occ.reminder) return false;
      return bizDateKey(occ.reminder.remindAt) <= today;
    }).filter(notDismissed);
  }, [myItems, forAdmin, today, dismissed]);

  const showRoutePlanReminder = !dismissed.has("__route_plan__") && !forAdmin;
  const hasReminders = showRoutePlanReminder || followUps.length > 0 || overdue.length > 0 || todayJobs.length > 0 || tomorrowJobs.length > 0 || pendingPayment.length > 0 || estimatesReady.length > 0;
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
      <HStack mb={2} gap={2}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          placeholder="Search planning…"
          inputId="planning-search"
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
            {hasDismissed ? `Nothing to plan — ${dismissed.size} dismissed today.` : "Nothing to plan right now."}
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
                      // Set date to tomorrow and navigate to Routes tab
                      const tomorrow = new Date(Date.now() + 86400000);
                      const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
                      try { localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(tomorrowStr)); } catch {}
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


      {followUps.length > 0 && (
        <Section
          title="Follow-ups"
          subtitle="Reminders you set that are now due"
          color="orange.600"
          items={followUps}
          badge={(occ) => {
            const note = occ.reminder?.note;
            return (
              <Badge colorPalette="orange" variant="solid" fontSize="xs" borderRadius="full" px="2">
                <Bell size={10} style={{ marginRight: 3 }} />
                {note || "Follow up"}
              </Badge>
            );
          }}
          message="Follow up on this job"
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
          me={me}
          onDismiss={(occId) => {
            void apiPost(`/api/occurrences/${occId}/reminder/clear`);
            dismissReminder(occId);
          }}
          dismissLabel="Clear Reminder"
        />
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
          message={(occ) => {
            if (occ.workflow === "TASK") return occ.notes ?? "Overdue task";
            const name = contactName(occ);
            const address = occ.job?.property?.street1 ?? occ.job?.property?.displayName ?? "";
            return `Hi ${name}, this is Seedlings Lawn Care. We had a service scheduled at ${address} that we weren't able to complete. Would you like us to reschedule? Please let us know a good time. Thank you!`;
          }}
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
          me={me}
          onDismiss={dismissReminder}
        />
      )}

      {todayJobs.length > 0 && (
        <Section
          title="Today"
          subtitle="Jobs scheduled for today — confirm with client"
          color="blue.600"
          items={todayJobs}
          badge={(occ) => <Badge colorPalette={occ.workflow === "TASK" ? "blue" : "blue"} variant="solid" fontSize="xs" borderRadius="full" px="2">{occ.workflow === "TASK" ? "Task — Today" : "Today"}</Badge>}
          message={(occ) => {
            if (occ.workflow === "TASK") return occ.notes ?? "Task for today";
            const name = contactName(occ);
            const address = occ.job?.property?.street1 ?? occ.job?.property?.displayName ?? "";
            return `Hi ${name}, this is Seedlings Lawn Care. Just confirming we're scheduled for service today at ${address}. Please let us know if anything has changed. Thank you!`;
          }}
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
          me={me}
          onDismiss={dismissReminder}
        />
      )}

      {tomorrowJobs.length > 0 && (
        <Section
          title="Tomorrow"
          subtitle="Jobs scheduled for tomorrow — reach out to confirm"
          color="teal.600"
          items={tomorrowJobs}
          badge={(occ) => <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">{occ.workflow === "TASK" ? "Task — Tomorrow" : "Tomorrow"}</Badge>}
          message={(occ) => {
            if (occ.workflow === "TASK") return occ.notes ?? "Task for tomorrow";
            const name = contactName(occ);
            const address = occ.job?.property?.street1 ?? occ.job?.property?.displayName ?? "";
            return `Hi ${name}, this is Seedlings Lawn Care. We have you scheduled for service tomorrow at ${address}. Please let us know if you need to make any changes. Thank you!`;
          }}
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
          me={me}
          onDismiss={dismissReminder}
        />
      )}

      {pendingPayment.length > 0 && (
        <Section
          title="Pending Payment"
          subtitle="These jobs are complete but payment hasn't been collected"
          color="orange.600"
          items={pendingPayment}
          badge={() => <Badge colorPalette="orange" variant="solid" fontSize="xs" borderRadius="full" px="2">Awaiting payment</Badge>}
          message={(occ) => {
            const name = contactName(occ);
            const address = occ.job?.property?.street1 ?? occ.job?.property?.displayName ?? "";
            const amount = occ.price != null ? ` The total is $${occ.price.toFixed(2)}.` : "";
            return `Hi ${name}, this is Seedlings Lawn Care. We've completed the service at ${address}.${amount} Please let us know how you'd like to handle payment. Thank you!`;
          }}
          showAssignees={showAll}
          forAdmin={forAdmin}
          compact={compact}
          expandedCards={expandedCards}
          toggleCard={toggleCard}
          me={me}
          onDismiss={dismissReminder}
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
          me={me}
          onDismiss={dismissReminder}
        />
      )}

      {hasDismissed && hasReminders && (
        <Box textAlign="center" py={3}>
          <Button size="sm" variant="ghost" colorPalette="gray" onClick={undismissAll}>
            Show {dismissed.size} dismissed
          </Button>
        </Box>
      )}
    </Box>
  );
}

function getContactInfo(occ: WorkerOccurrence): { phone?: string; email?: string } | null {
  // Check the occurrence's own property contact, then fall back to linked occurrence's contact
  const poc = occ.job?.property?.pointOfContact
    ?? occ.linkedOccurrence?.job?.property?.pointOfContact;
  if (!poc) return null;
  return { phone: poc.phone ?? undefined, email: poc.email ?? undefined };
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
  onDismiss,
  dismissLabel = "Dismiss",
  me,
}: {
  title: string;
  subtitle: string;
  color: string;
  items: WorkerOccurrence[];
  badge: (occ: WorkerOccurrence) => React.ReactNode;
  message: string | ((occ: WorkerOccurrence) => string);
  showAssignees?: boolean;
  forAdmin?: boolean;
  compact: boolean;
  expandedCards: Set<string>;
  toggleCard: (id: string) => void;
  onDismiss?: (id: string) => void;
  dismissLabel?: string;
  me?: Me | null;
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
                        occ.workflow === "TASK" ? (occ.title ?? "") : (occ.job?.property?.displayName ?? ""),
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
                    onClick={(e) => { e.stopPropagation(); onDismiss?.(occ.id); }}
                  >
                    {dismissLabel}
                  </Button>
                </Box>
              )}
              <Card.Body py="3" px="4" pt={isExpanded ? "2" : "3"}>
                <HStack justify="space-between" align="start" gap={3}>
                  <VStack align="start" gap={1} flex="1" minW={0}>
                    <Text fontSize={isExpanded ? "sm" : "sm"} fontWeight="medium">
                      {occ.workflow === "TASK" || occ.workflow === "REMINDER" ? (occ.title || (occ.workflow === "TASK" ? "Task" : "Reminder")) : occ.job?.property?.displayName ? (
                        <>
                          {occ.job.property.displayName}
                          {occ.job.property.client?.displayName && (
                            <> — {clientLabel(occ.job.property.client.displayName)}</>
                          )}
                        </>
                      ) : (occ.title || "Job")}
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
                        {(() => {
                          const msg = typeof message === "function" ? message(occ) : message;
                          const contact = getContactInfo(occ);
                          const contactPhone = contact?.phone;
                          const contactEmail = contact?.email;
                          return (
                            <VStack align="stretch" gap={1}>
                              <Text fontSize="xs" color="fg.muted" fontStyle="italic">{msg}</Text>
                              <HStack gap={1} flexWrap="wrap">
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  colorPalette="gray"
                                  px="1"
                                  minW="0"
                                  flexShrink={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(msg);
                                    publishInlineMessage({ type: "SUCCESS", text: "Copied!" });
                                  }}
                                  title="Copy to clipboard"
                                >
                                  <Copy size={12} style={{ display: "block" }} />
                                  <Text fontSize="xs">Copy</Text>
                                </Button>
                                {contactPhone && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="green"
                                    px="1"
                                    minW="0"
                                    flexShrink={0}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.open(`sms:${contactPhone}?body=${encodeURIComponent(msg)}`, "_self");
                                    }}
                                    title={`Text ${contactPhone}`}
                                  >
                                    <MessageCircle size={12} style={{ display: "block" }} />
                                    <Text fontSize="xs">Text</Text>
                                  </Button>
                                )}
                                {!contactPhone && contactEmail && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="blue"
                                    px="1"
                                    minW="0"
                                    flexShrink={0}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const fromName = me?.displayName || "Seedlings Lawn Care";
                                      const subject = encodeURIComponent(`Message from ${fromName}`);
                                      window.open(`mailto:${contactEmail}?subject=${subject}&body=${encodeURIComponent(msg)}`, "_self");
                                    }}
                                    title={`Email ${contactEmail}`}
                                  >
                                    <Mail size={12} style={{ display: "block" }} />
                                    <Text fontSize="xs">Email</Text>
                                  </Button>
                                )}
                              </HStack>
                            </VStack>
                          );
                        })()}
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
                          onClick={(e) => { e.stopPropagation(); onDismiss?.(occ.id); }}
                        >
                          {dismissLabel}
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
