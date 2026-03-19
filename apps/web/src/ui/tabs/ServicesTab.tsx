"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Card,
  HStack,
  Input,
  Spacer,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  determineRoles,
  jobStatusColor,
  occurrenceStatusColor,
  prettyStatus,
} from "@/src/lib/lib";
import {
  type TabPropsType,
  JOB_KIND,
  JOB_STATUS,
  JOB_OCCURRENCE_STATUS,
  type JobListItem,
  type JobDetail,
  type JobOccurrenceFull,
} from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import JobDialog from "@/src/ui/dialogs/JobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";
import AssigneeDialog from "@/src/ui/dialogs/AssigneeDialog";
import DeleteDialog, { type ToDeleteProps } from "@/src/ui/dialogs/DeleteDialog";
import ScheduleNextDialog from "@/src/ui/dialogs/ScheduleNextDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch, onEventSearchRun } from "@/src/lib/bus";
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

const kindStates = ["ALL", ...JOB_KIND] as const;

export default function ServicesTab({
  me,
  purpose = "ADMIN",
}: TabPropsType) {
  const { isAvail, forAdmin, isSuper } = determineRoles(me, purpose);
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string[]>(["ALL"]);
  const [activeJobStatuses, setActiveJobStatuses] = useState<Set<string>>(
    new Set(["PROPOSED", "ACCEPTED"])
  );

  function toggleJobStatus(val: string) {
    setActiveJobStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }
  const [activeOccFilters, setActiveOccFilters] = useState<Set<string>>(
    new Set(["UNCLAIMED", "SCHEDULED", "IN_PROGRESS", "PENDING_PAYMENT", "CLOSED"])
  );

  function toggleOccFilter(val: string) {
    setActiveOccFilters((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );
  const [items, setItems] = useState<JobListItem[]>([]);
  const [loading, setLoading] = useState(false);

  const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});

  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobListItem | null>(null);

  const [occurrenceDialogOpen, setOccurrenceDialogOpen] = useState(false);
  const [occurrenceJobId, setOccurrenceJobId] = useState<string>("");
  const [occurrenceDefaultNotes, setOccurrenceDefaultNotes] = useState<string | null>(null);
  const [occurrenceDefaultPrice, setOccurrenceDefaultPrice] = useState<number | null>(null);
  const [occurrenceJobHasFrequency, setOccurrenceJobHasFrequency] = useState(false);

  const [editOccurrenceDialogOpen, setEditOccurrenceDialogOpen] = useState(false);
  const [editingOccurrence, setEditingOccurrence] = useState<JobOccurrenceFull | null>(null);
  const [editOccurrenceJobId, setEditOccurrenceJobId] = useState<string>("");

  const [assigneeDialogOpen, setAssigneeDialogOpen] = useState(false);
  const [assigneeOccurrenceId, setAssigneeOccurrenceId] = useState<string>("");
  const [assigneeCurrentAssignees, setAssigneeCurrentAssignees] = useState<JobOccurrenceAssigneeWithUser[]>([]);
  const [assigneeJobId, setAssigneeJobId] = useState<string>("");

  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  type DeleteTarget = ToDeleteProps & { deleteType: "archived-job" | "archived-occurrence"; jobId?: string };
  const [toDelete, setToDelete] = useState<DeleteTarget | null>(null);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    colorPalette: string;
    onConfirm: () => void;
  } | null>(null);

  const [acceptPaymentOpen, setAcceptPaymentOpen] = useState(false);
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<JobOccurrenceFull | null>(null);
  const [acceptPaymentJobId, setAcceptPaymentJobId] = useState<string>("");

  const [scheduleNextOpen, setScheduleNextOpen] = useState(false);
  const [scheduleNextData, setScheduleNextData] = useState<{
    jobId: string;
    frequencyDays: number;
    closedOccurrence: { startAt?: string | null; endAt?: string | null; notes?: string | null; price?: number | null };
  } | null>(null);

  async function load(displayLoading = true) {
    setLoading(displayLoading);
    try {
      const list = await apiGet<JobListItem[]>("/api/admin/jobs?status=ALL");
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load jobs.", err),
      });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    onEventSearchRun("paymentsTabToServicesTabSearch", setQ, inputRef);
  }, []);

  async function loadDetail(jobId: string, force = false) {
    if (!force && (jobDetails[jobId] || detailLoading[jobId])) return;
    setDetailLoading((prev) => ({ ...prev, [jobId]: true }));
    try {
      const detail = await apiGet<JobDetail>(`/api/admin/jobs/${jobId}`);
      setJobDetails((prev) => ({ ...prev, [jobId]: detail }));
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load job details.", err),
      });
    } finally {
      setDetailLoading((prev) => ({ ...prev, [jobId]: false }));
    }
  }

  function toggleExpand(jobId: string) {
    const next = !expandedMap[jobId];
    setExpandedMap((prev) => ({ ...prev, [jobId]: next }));
    if (next) void loadDetail(jobId);
  }

  async function patchJobStatus(job: JobListItem, newStatus: string) {
    try {
      await apiPatch(`/api/admin/jobs/${job.id}`, { status: newStatus });
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Job status updated to ${prettyStatus(newStatus)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update job failed.", err),
      });
    }
  }

  async function patchOccurrenceStatus(occurrenceId: string, jobId: string, newStatus: string) {
    // Capture occurrence data before the API call for schedule-next prompt
    const detail = jobDetails[jobId];
    const occ = detail?.occurrences.find((o) => o.id === occurrenceId);
    const job = items.find((j) => j.id === jobId);
    try {
      await apiPatch(`/api/admin/occurrences/${occurrenceId}`, { status: newStatus });
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence updated." });

      // Prompt to schedule next occurrence if job has a frequency (skip for one-off)
      if (newStatus === "CLOSED" && job?.frequencyDays && occ && !occ.isOneOff) {
        setScheduleNextData({
          jobId,
          frequencyDays: job.frequencyDays,
          closedOccurrence: {
            startAt: occ.startAt,
            endAt: occ.endAt,
            notes: occ.notes,
            price: occ.price,
          },
        });
        setScheduleNextOpen(true);
      }
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update occurrence failed.", err),
      });
    }
  }

  async function deleteJob(jobId: string) {
    try {
      await apiDelete(`/api/admin/jobs/${jobId}`);
      await load(false);
      publishInlineMessage({ type: "SUCCESS", text: "Job deleted." });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete job failed.", err),
      });
    }
  }

  async function openDeleteJobDialog(job: JobListItem) {
    // Ensure detail is loaded so we can check occurrence count
    let detail = jobDetails[job.id];
    if (!detail) {
      try {
        detail = await apiGet<JobDetail>(`/api/admin/jobs/${job.id}`);
        setJobDetails((prev) => ({ ...prev, [job.id]: detail! }));
      } catch {
        // proceed without detail; API will guard server-side
      }
    }

    const occurrenceCount = detail?.occurrences.length ?? 0;
    const hasOccurrences = occurrenceCount > 0;
    const superRequired = !isSuper;

    setToDelete({
      deleteType: "archived-job",
      id: job.id,
      title: "Delete job?",
      summary: job.property?.displayName ?? job.id,
      disabled: hasOccurrences || superRequired,
      details: hasOccurrences ? (
        <Text color="red.500">
          This job has {occurrenceCount} occurrence{occurrenceCount !== 1 ? "s" : ""}. Delete all job occurrences before deleting the job.
        </Text>
      ) : superRequired ? (
        <Text color="red.500">You must be a Super Admin to delete.</Text>
      ) : undefined,
    });
  }

  async function archiveJob(jobId: string) {
    try {
      await apiPost(`/api/admin/jobs/${jobId}/archive`);
      await load(false);
      publishInlineMessage({ type: "SUCCESS", text: "Job archived." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Archive job failed.", err) });
    }
  }

  async function deleteOccurrence(occurrenceId: string, jobId: string) {
    try {
      await apiDelete(`/api/admin/occurrences/${occurrenceId}`);
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence deleted." });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete occurrence failed.", err),
      });
    }
  }

  async function archiveOccurrence(occurrenceId: string, jobId: string) {
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/archive`);
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence archived." });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Archive occurrence failed.", err),
      });
    }
  }

  const filtered = useMemo(() => {
    let rows = items;
    if (activeJobStatuses.size > 0) rows = rows.filter((i) => activeJobStatuses.has(i.status));
    if (kind[0] !== "ALL") rows = rows.filter((i) => i.kind === kind[0]);
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) =>
        [r.property?.displayName, r.property?.street1, r.property?.city, r.property?.state, r.kind, r.status]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    return rows;
  }, [items, q, kind, activeJobStatuses]);

  if (!isAvail) return <UnavailableNotice />;
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={3} gap={3}>
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={setQ}
          inputId="services-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={kindCollection}
          value={kind}
          onValueChange={(e) => setKind(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Kind" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {kindItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Spacer />
        {forAdmin && (
          <Button
            onClick={() => {
              setEditingJob(null);
              setJobDialogOpen(true);
            }}
          >
            New Job
          </Button>
        )}
      </HStack>

      <HStack mb={3} gap={2} align="center">
        <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">
          Date range:
        </Text>
        <Input
          type="date"
          size="sm"
          value={dateFrom}
          onChange={(e) => {
            const val = e.target.value;
            setDateFrom(val);
            if (dateTo && val && val > dateTo) setDateTo(val);
          }}
          maxW="160px"
        />
        <Text fontSize="sm">–</Text>
        <Input
          type="date"
          size="sm"
          value={dateTo}
          onChange={(e) => {
            const val = e.target.value;
            setDateTo(val);
            if (dateFrom && val && val < dateFrom) setDateFrom(val);
          }}
          maxW="160px"
        />
        {(dateFrom || dateTo) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear
          </Button>
        )}
      </HStack>

      <HStack mb={1} gap={2} align="center" wrap="wrap">
        <Text fontSize="xs" fontWeight="semibold" color="fg.muted" whiteSpace="nowrap">
          Jobs:
        </Text>
        {JOB_STATUS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={activeJobStatuses.has(s) ? "solid" : "outline"}
            colorPalette={s === "ARCHIVED" ? "gray" : undefined}
            onClick={() => toggleJobStatus(s)}
          >
            {prettyStatus(s)}
          </Button>
        ))}
      </HStack>

      <HStack mb={3} gap={2} align="center" wrap="wrap">
        <Text fontSize="xs" fontWeight="semibold" color="fg.muted" whiteSpace="nowrap">
          Occurrences:
        </Text>
        <Button
          key="UNCLAIMED"
          size="sm"
          variant={activeOccFilters.has("UNCLAIMED") ? "solid" : "outline"}
          onClick={() => toggleOccFilter("UNCLAIMED")}
        >
          Unclaimed
        </Button>
        {JOB_OCCURRENCE_STATUS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={activeOccFilters.has(s) ? "solid" : "outline"}
            onClick={() => toggleOccFilter(s)}
          >
            {prettyStatus(s)}
          </Button>
        ))}
      </HStack>

      <VStack align="stretch" gap={3}>
        {filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No jobs match current filters.
          </Box>
        )}

        {filtered.map((job) => {
          const expanded = !!expandedMap[job.id];
          const detail = jobDetails[job.id];
          const isLoadingDetail = !!detailLoading[job.id];
          const visibleOccs = detail
            ? detail.occurrences.filter((o: JobOccurrenceFull) => {
                if (o.startAt) {
                  const d = o.startAt.slice(0, 10);
                  if (dateFrom && d < dateFrom) return false;
                  if (dateTo && d > dateTo) return false;
                }
                const isUnclaimed = o.assignees.length === 0;
                if (isUnclaimed) return activeOccFilters.has("UNCLAIMED");
                return activeOccFilters.has(o.status);
              })
            : [];

          return (
            <Card.Root key={job.id} variant="outline">
              <Card.Header pb="2">
                <HStack gap={3} justify="space-between" align="center">
                  <HStack gap={3} flex="1" minW={0}>
                    <VStack align="start" gap={0}>
                      <Text fontWeight="semibold">
                        {job.property?.displayName ?? job.propertyId}
                      </Text>
                      {job.property?.displayName && (
                        <TextLink
                          text="View Property"
                          onClick={() =>
                            openEventSearch(
                              "jobsTabToPropertiesTabSearch",
                              job.property?.displayName ?? "",
                              forAdmin,
                            )
                          }
                        />
                      )}
                      {job.property?.client?.displayName && (
                        <Text fontSize="xs" color="fg.muted">
                          Client: {job.property.client.displayName}
                        </Text>
                      )}
                    </VStack>
                    <StatusBadge
                      status={job.status}
                      palette={jobStatusColor(job.status)}
                      variant="subtle"
                    />
                  </HStack>
                  <StatusBadge status={job.kind} palette="gray" variant="outline" />
                </HStack>
                {(job.property?.street1 || job.property?.city) && (
                  <Box mt="1">
                    <MapLink address={[job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ")} />
                  </Box>
                )}
              </Card.Header>

              <Card.Body pt="0">
                <VStack align="start" gap={0} mb={2}>
                  <Text fontSize="sm" color="fg.muted">
                    Default price:{" "}
                    {job.defaultPrice != null ? (
                      <b>${job.defaultPrice.toFixed(2)}</b>
                    ) : (
                      <span>Not set</span>
                    )}
                  </Text>
                  {job.frequencyDays && (
                    <Text fontSize="sm" color="fg.muted">
                      Frequency: every {job.frequencyDays} day{job.frequencyDays !== 1 ? "s" : ""}
                    </Text>
                  )}
                  {job.notes && (
                    <Text fontSize="sm" color="fg.muted">
                      {job.notes}
                    </Text>
                  )}
                </VStack>
                {(detail ? detail.occurrences.length === 0 : (job.occurrenceCount ?? 0) === 0) ? (
                  <Text fontSize="sm" color="fg.muted">No occurrences</Text>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => toggleExpand(job.id)}
                  >
                    {expanded
                      ? `Hide occurrences (${detail ? detail.occurrences.length : (job.occurrenceCount ?? 0)}) ▲`
                      : `Show occurrences (${detail ? detail.occurrences.length : (job.occurrenceCount ?? 0)}) ▼`}
                  </Button>
                )}

                {expanded && (
                  <Box mt={2}>
                    {isLoadingDetail && !detail && (
                      <Text fontSize="sm" color="fg.muted">
                        Loading…
                      </Text>
                    )}
                    {detail && detail.occurrences.length === 0 && (
                      <Text fontSize="sm" color="fg.muted">
                        No occurrences.
                      </Text>
                    )}
                    {detail && detail.occurrences.length > 0 && visibleOccs.length === 0 && (
                      <Text fontSize="sm" color="fg.muted">
                        No occurrences match the current status filters.
                      </Text>
                    )}
                    {detail && visibleOccs.map((occ: JobOccurrenceFull) => (
                      <Box
                        key={occ.id}
                        p={2}
                        borderWidth="1px"
                        rounded="md"
                        mb={2}
                      >
                        <HStack justify="space-between" align="center">
                          <VStack align="start" gap={0}>
                            <Text fontSize="sm" fontWeight="medium">
                              {occ.startAt
                                ? new Date(occ.startAt).toLocaleDateString()
                                : "—"}
                            </Text>
                            {occ.assignees.length === 0 ? (
                              <Text fontSize="xs" color="orange.500" fontWeight="medium">
                                Unclaimed — available to pick up
                              </Text>
                            ) : (
                              <VStack align="start" gap={0}>
                                {occ.assignees.map((a) => {
                                  const isClaimer = a.assignedById === a.userId;
                                  return (
                                    <Text
                                      key={a.userId}
                                      fontSize="xs"
                                      fontWeight={isClaimer ? "medium" : "normal"}
                                      color={isClaimer ? "teal.700" : "fg.muted"}
                                    >
                                      {a.user.displayName ?? a.user.email ?? a.userId}
                                      {isClaimer ? " · Claimer" : ""}
                                    </Text>
                                  );
                                })}
                              </VStack>
                            )}
                            <Text fontSize="xs" color="fg.muted">
                              Price:{" "}
                              {occ.price != null ? (
                                <b>${occ.price.toFixed(2)}</b>
                              ) : (
                                <span>Not set</span>
                              )}
                            </Text>
                            {occ.notes && (
                              <Text fontSize="xs" color="fg.muted">
                                {occ.notes}
                              </Text>
                            )}
                            {occ.payment && (
                              <Box mt={1} p={1} bg="green.50" rounded="sm">
                                <Text fontSize="xs" fontWeight="medium" color="green.700">
                                  Paid: ${occ.payment.amountPaid.toFixed(2)} via {prettyStatus(occ.payment.method)}
                                </Text>
                                {occ.payment.note && (
                                  <Text fontSize="xs" color="green.600">{occ.payment.note}</Text>
                                )}
                                {occ.payment.splits && occ.payment.splits.length > 1 && (
                                  <VStack align="start" gap={0} mt={0.5}>
                                    {occ.payment.splits.map((sp: any) => (
                                      <Text key={sp.userId} fontSize="xs" color="green.600">
                                        {sp.user?.displayName ?? sp.userId}: ${sp.amount.toFixed(2)}
                                      </Text>
                                    ))}
                                  </VStack>
                                )}
                              </Box>
                            )}

                            {occ.expenses && occ.expenses.length > 0 && (
                              <Box mt={1} p={1} bg="orange.50" rounded="sm">
                                <Text fontSize="xs" fontWeight="medium" color="orange.700">
                                  Expenses: ${occ.expenses.reduce((s: number, e: any) => s + e.cost, 0).toFixed(2)}
                                </Text>
                                <VStack align="start" gap={0} mt={0.5}>
                                  {occ.expenses.map((exp: any) => (
                                    <Text key={exp.id} fontSize="xs" color="orange.600">
                                      ${exp.cost.toFixed(2)} — {exp.description}
                                    </Text>
                                  ))}
                                </VStack>
                              </Box>
                            )}
                          </VStack>
                          <StatusBadge
                            status={occ.status}
                            palette={occurrenceStatusColor(occ.status)}
                            variant="subtle"
                          />
                        </HStack>

                        {forAdmin && (
                          <HStack gap={2} mt={2} wrap="wrap">
                            <StatusButton
                              id="occ-edit"
                              itemId={occ.id}
                              label="Edit"
                              onClick={async () => {
                                setEditingOccurrence(occ);
                                setEditOccurrenceJobId(job.id);
                                setEditOccurrenceDialogOpen(true);
                              }}
                              variant="outline"
                              busyId={statusButtonBusyId}
                              setBusyId={setStatusButtonBusyId}
                            />
                            {occ.status !== "PENDING_PAYMENT" && occ.status !== "CLOSED" && occ.status !== "ARCHIVED" && (
                              <StatusButton
                                id="occ-assignees"
                                itemId={occ.id}
                                label="Manage Team"
                                onClick={async () => {
                                  setAssigneeOccurrenceId(occ.id);
                                  setAssigneeCurrentAssignees(occ.assignees);
                                  setAssigneeJobId(job.id);
                                  setAssigneeDialogOpen(true);
                                }}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "SCHEDULED" && (
                              <StatusButton
                                id="occ-start"
                                itemId={occ.id}
                                label="Start"
                                onClick={async () => setConfirmAction({
                                  title: "Start Occurrence?",
                                  message: "Are you sure you want to start this occurrence?",
                                  confirmLabel: "Start",
                                  colorPalette: "blue",
                                  onConfirm: () => void patchOccurrenceStatus(occ.id, job.id, "IN_PROGRESS"),
                                })}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "IN_PROGRESS" && (
                              <StatusButton
                                id="occ-complete"
                                itemId={occ.id}
                                label="Complete"
                                onClick={async () => setConfirmAction({
                                  title: "Complete Occurrence?",
                                  message: "Are you sure you want to mark this occurrence as complete?",
                                  confirmLabel: "Complete",
                                  colorPalette: "green",
                                  onConfirm: () => void patchOccurrenceStatus(occ.id, job.id, "PENDING_PAYMENT"),
                                })}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "SCHEDULED" && (
                              <StatusButton
                                id="occ-cancel"
                                itemId={occ.id}
                                label="Cancel"
                                onClick={async () => {
                                  const dateLabel = occ.startAt
                                    ? new Date(occ.startAt).toLocaleDateString()
                                    : "unknown date";
                                  setToDelete({
                                    deleteType: "archived-occurrence",
                                    jobId: job.id,
                                    id: occ.id,
                                    title: "Cancel occurrence?",
                                    summary: `Occurrence on ${dateLabel} will be deleted.`,
                                    disabled: false,
                                  });
                                }}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "IN_PROGRESS" && (
                              <StatusButton
                                id="occ-cancel"
                                itemId={occ.id}
                                label="Cancel"
                                onClick={async () => {
                                  const dateLabel = occ.startAt
                                    ? new Date(occ.startAt).toLocaleDateString()
                                    : "unknown date";
                                  setToDelete({
                                    deleteType: "archived-occurrence",
                                    jobId: job.id,
                                    id: occ.id,
                                    title: "Cancel occurrence?",
                                    summary: `Occurrence on ${dateLabel} will be deleted.`,
                                    disabled: false,
                                  });
                                }}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "PENDING_PAYMENT" && (
                              <StatusButton
                                id="occ-accept-payment"
                                itemId={occ.id}
                                label="Accept Payment"
                                onClick={async () => {
                                  setAcceptPaymentOcc(occ);
                                  setAcceptPaymentJobId(job.id);
                                  setAcceptPaymentOpen(true);
                                }}
                                variant="outline"
                                colorPalette="green"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "CLOSED" && (
                              <StatusButton
                                id="occ-archive"
                                itemId={occ.id}
                                label="Archive"
                                onClick={async () => setConfirmAction({
                                  title: "Archive Occurrence?",
                                  message: "Are you sure you want to archive this occurrence?",
                                  confirmLabel: "Archive",
                                  colorPalette: "gray",
                                  onConfirm: () => void archiveOccurrence(occ.id, job.id),
                                })}
                                variant="outline"
                                colorPalette="gray"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            <StatusButton
                              id="occ-delete"
                              itemId={occ.id}
                              label="Delete"
                              onClick={async () => {
                                const dateLabel = occ.startAt
                                  ? new Date(occ.startAt).toLocaleDateString()
                                  : "unknown date";
                                setToDelete({
                                  deleteType: "archived-occurrence",
                                  jobId: job.id,
                                  id: occ.id,
                                  title: "Delete occurrence?",
                                  summary: `Occurrence on ${dateLabel}`,
                                  disabled: !isSuper,
                                  details: !isSuper ? (
                                    <Text color="red.500">You must be a Super Admin to delete.</Text>
                                  ) : undefined,
                                });
                              }}
                              variant="outline"
                              colorPalette="red"
                              busyId={statusButtonBusyId}
                              setBusyId={setStatusButtonBusyId}
                            />
                          </HStack>
                        )}
                      </Box>
                    ))}
                  </Box>
                )}
              </Card.Body>

              {forAdmin && (
                <Card.Footer>
                  <HStack gap={2} wrap="wrap" mb="2">
                    <StatusButton
                      id="job-edit"
                      itemId={job.id}
                      label="Edit"
                      onClick={async () => {
                        setEditingJob(job);
                        setJobDialogOpen(true);
                      }}
                      variant="outline"
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                    {job.status === "ACCEPTED" && (
                      <StatusButton
                        id="job-new-occurrence"
                        itemId={job.id}
                        label="+ Occurrence"
                        onClick={async () => {
                          setOccurrenceJobId(job.id);
                          setOccurrenceDefaultNotes(job.notes ?? null);
                          setOccurrenceDefaultPrice(job.defaultPrice ?? null);
                          setOccurrenceJobHasFrequency(!!job.frequencyDays);
                          setOccurrenceDialogOpen(true);
                        }}
                        variant="outline"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {job.status === "PROPOSED" && (
                      <StatusButton
                        id="job-accept"
                        itemId={job.id}
                        label="Accept"
                        onClick={async () => patchJobStatus(job, "ACCEPTED")}
                        variant="outline"
                        colorPalette="green"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {job.status === "ACCEPTED" && (
                      <StatusButton
                        id="job-archive"
                        itemId={job.id}
                        label="Archive"
                        onClick={async () => archiveJob(job.id)}
                        variant="outline"
                        colorPalette="gray"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    <StatusButton
                      id="job-delete"
                      itemId={job.id}
                      label="Delete"
                      onClick={async () => openDeleteJobDialog(job)}
                      variant="outline"
                      colorPalette="red"
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                  </HStack>
                </Card.Footer>
              )}
            </Card.Root>
          );
        })}
      </VStack>

      {forAdmin && (
        <JobDialog
          open={jobDialogOpen}
          onOpenChange={setJobDialogOpen}
          mode={editingJob ? "UPDATE" : "CREATE"}
          initial={editingJob}
          onSaved={(created) => {
            void load();
            if (created) {
              setOccurrenceJobId(created.id);
              setOccurrenceDefaultNotes(created.notes ?? null);
              setOccurrenceDefaultPrice(created.defaultPrice ?? null);
              setOccurrenceJobHasFrequency(!!(created.frequencyDays));
              setOccurrenceDialogOpen(true);
            }
          }}
        />
      )}

      {forAdmin && (
        <OccurrenceDialog
          open={occurrenceDialogOpen}
          onOpenChange={setOccurrenceDialogOpen}
          jobId={occurrenceJobId}
          defaultNotes={occurrenceDefaultNotes}
          defaultPrice={occurrenceDefaultPrice}
          showOneOff={occurrenceJobHasFrequency}
          onSaved={() => {
            if (occurrenceJobId) {
              setExpandedMap((prev) => ({ ...prev, [occurrenceJobId]: true }));
              void loadDetail(occurrenceJobId, true);
            }
          }}
        />
      )}

      {forAdmin && editingOccurrence && (
        <OccurrenceDialog
          open={editOccurrenceDialogOpen}
          onOpenChange={(open) => {
            setEditOccurrenceDialogOpen(open);
            if (!open) setEditingOccurrence(null);
          }}
          mode="UPDATE"
          occurrenceId={editingOccurrence.id}
          defaultStatus={editingOccurrence.status}
          defaultKind={editingOccurrence.kind}
          defaultStartAt={editingOccurrence.startAt}
          defaultEndAt={editingOccurrence.endAt}
          defaultNotes={editingOccurrence.notes}
          defaultPrice={editingOccurrence.price}
          onSaved={() => {
            if (editOccurrenceJobId) void loadDetail(editOccurrenceJobId, true);
          }}
        />
      )}

      <DeleteDialog
        toDelete={toDelete}
        cancel={() => setToDelete(null)}
        complete={async () => {
          if (!toDelete) return;
          if (toDelete.deleteType === "archived-job") {
            await deleteJob(toDelete.id);
          } else {
            await deleteOccurrence(toDelete.id, toDelete.jobId!);
          }
          setToDelete(null);
        }}
      />

      {forAdmin && (
        <AssigneeDialog
          open={assigneeDialogOpen}
          onOpenChange={setAssigneeDialogOpen}
          occurrenceId={assigneeOccurrenceId}
          currentAssignees={assigneeCurrentAssignees}
          onChanged={() => {
            if (assigneeJobId) {
              void loadDetail(assigneeJobId, true);
            }
          }}
        />
      )}

      {scheduleNextData && (
        <ScheduleNextDialog
          open={scheduleNextOpen}
          onOpenChange={(o) => {
            setScheduleNextOpen(o);
            if (!o) setScheduleNextData(null);
          }}
          jobId={scheduleNextData.jobId}
          frequencyDays={scheduleNextData.frequencyDays}
          closedOccurrence={scheduleNextData.closedOccurrence}
          createEndpoint={`/api/admin/jobs/${scheduleNextData.jobId}/occurrences`}
          onCreated={(nextStartDate) => {
            if (nextStartDate && dateTo && nextStartDate > dateTo) {
              setDateTo(nextStartDate);
            }
            void loadDetail(scheduleNextData.jobId, true);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        confirmLabel={confirmAction?.confirmLabel}
        confirmColorPalette={confirmAction?.colorPalette}
        onConfirm={() => {
          confirmAction?.onConfirm();
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      {acceptPaymentOcc && (
        <AcceptPaymentDialog
          open={acceptPaymentOpen}
          onOpenChange={(o) => {
            setAcceptPaymentOpen(o);
            if (!o) setAcceptPaymentOcc(null);
          }}
          endpoint={`/api/admin/occurrences/${acceptPaymentOcc.id}/accept-payment`}
          defaultAmount={acceptPaymentOcc.price}
          assignees={(acceptPaymentOcc.assignees ?? []).map((a) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
          }))}
          onAccepted={() => {
            const occ = acceptPaymentOcc;
            const jobId = acceptPaymentJobId;
            if (jobId) void loadDetail(jobId, true);
            // Prompt to schedule next if job has frequency and not one-off
            const job = items.find((j) => j.id === jobId);
            if (job?.frequencyDays && occ && !occ.isOneOff) {
              setScheduleNextData({
                jobId,
                frequencyDays: job.frequencyDays,
                closedOccurrence: {
                  startAt: occ.startAt,
                  endAt: occ.endAt,
                  notes: occ.notes,
                  price: occ.price,
                },
              });
              setScheduleNextOpen(true);
            }
            setAcceptPaymentOcc(null);
          }}
        />
      )}
    </Box>
  );
}
