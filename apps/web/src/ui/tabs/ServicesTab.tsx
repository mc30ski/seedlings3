"use client";

import { useEffect, useMemo, useState } from "react";
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
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

const kindStates = ["ALL", ...JOB_KIND] as const;
const statusStates = ["ALL", ...JOB_STATUS] as const;

export default function ServicesTab({
  me,
  purpose = "ADMIN",
}: TabPropsType) {
  const { isAvail, forAdmin, isSuper } = determineRoles(me, purpose);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [kind, setKind] = useState<string[]>(["ALL"]);

  const [dateFrom, setDateFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
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

  const [assigneeDialogOpen, setAssigneeDialogOpen] = useState(false);
  const [assigneeOccurrenceId, setAssigneeOccurrenceId] = useState<string>("");
  const [assigneeCurrentAssignees, setAssigneeCurrentAssignees] = useState<JobOccurrenceAssigneeWithUser[]>([]);
  const [assigneeJobId, setAssigneeJobId] = useState<string>("");

  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");
  const [showArchivedOccs, setShowArchivedOccs] = useState<Record<string, boolean>>({});

  type DeleteTarget = ToDeleteProps & { deleteType: "archived-job" | "archived-occurrence"; jobId?: string };
  const [toDelete, setToDelete] = useState<DeleteTarget | null>(null);

  // Archived view (server-side paginated)
  const [archivedItems, setArchivedItems] = useState<JobListItem[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const archivedPageSize = 25;

  async function load(displayLoading = true) {
    setLoading(displayLoading);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const url = `/api/admin/jobs${qs.toString() ? `?${qs}` : ""}`;
      const list = await apiGet<JobListItem[]>(url);
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
  }, [dateFrom, dateTo]);

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
    try {
      await apiPatch(`/api/admin/occurrences/${occurrenceId}`, { status: newStatus });
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence updated." });
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

  async function loadArchived(page = 1, reset = true) {
    setArchivedLoading(true);
    try {
      const res = await apiGet<{ items: JobListItem[]; total: number; page: number; pageSize: number }>(
        `/api/admin/jobs/archived?page=${page}&pageSize=${archivedPageSize}`
      );
      setArchivedItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setArchivedTotal(res.total);
      setArchivedPage(page);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load archived jobs.", err) });
    } finally {
      setArchivedLoading(false);
    }
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
    if (kind[0] !== "ALL") rows = rows.filter((i) => i.kind === kind[0]);
    if (status !== "ALL") rows = rows.filter((i) => i.status === status);
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) =>
        [r.property?.displayName, r.property?.street1, r.property?.city, r.property?.state, r.kind, r.status]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    return rows;
  }, [items, q, kind, status]);

  if (!isAvail) return <UnavailableNotice />;
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={3} gap={3}>
        <SearchWithClear
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
          onChange={(e) => setDateFrom(e.target.value)}
          maxW="160px"
        />
        <Text fontSize="sm">–</Text>
        <Input
          type="date"
          size="sm"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
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

      <HStack mb={3} gap={2} wrap="wrap">
        {statusStates.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "solid" : "outline"}
            onClick={() => {
              setStatus(s);
              if (s === "ARCHIVED") void loadArchived(1, true);
            }}
          >
            {prettyStatus(s)}
          </Button>
        ))}
      </HStack>

      <VStack align="stretch" gap={3}>
        {status === "ARCHIVED" && archivedLoading && archivedItems.length === 0 && (
          <Box p="8" color="fg.muted">Loading archived jobs…</Box>
        )}
        {status === "ARCHIVED" && !archivedLoading && archivedItems.length === 0 && (
          <Box p="8" color="fg.muted">No archived jobs.</Box>
        )}
        {status !== "ARCHIVED" && filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No jobs match current filters.
          </Box>
        )}

        {(status === "ARCHIVED" ? archivedItems : filtered).map((job) => {
          const expanded = !!expandedMap[job.id];
          const detail = jobDetails[job.id];
          const isLoadingDetail = !!detailLoading[job.id];
          const archivedOccCount = detail?.occurrences.filter((o: JobOccurrenceFull) => o.status === "ARCHIVED").length ?? 0;
          const visibleOccs = detail
            ? (showArchivedOccs[job.id]
                ? detail.occurrences
                : detail.occurrences.filter((o: JobOccurrenceFull) => o.status !== "ARCHIVED"))
            : [];

          return (
            <Card.Root key={job.id} variant="outline">
              <Card.Header pb="2">
                <HStack gap={3} justify="space-between" align="center">
                  <HStack gap={3} flex="1" minW={0}>
                    <Text fontWeight="semibold">
                      {job.property?.displayName ?? job.propertyId}
                    </Text>
                    <StatusBadge
                      status={job.status}
                      palette={jobStatusColor(job.status)}
                      variant="subtle"
                    />
                  </HStack>
                  <StatusBadge status={job.kind} palette="gray" variant="outline" />
                </HStack>
                {(job.property?.street1 || job.property?.city) && (
                  <Text fontSize="sm" color="fg.muted" mt="1">
                    {[job.property.street1, job.property.city, job.property.state]
                      .filter(Boolean)
                      .join(", ")}
                  </Text>
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
                  {job.notes && (
                    <Text fontSize="sm" color="fg.muted">
                      {job.notes}
                    </Text>
                  )}
                </VStack>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => toggleExpand(job.id)}
                >
                  {expanded ? "Hide occurrences ▲" : "Show occurrences ▼"}
                </Button>

                {expanded && (
                  <Box mt={2}>
                    {isLoadingDetail && (
                      <Text fontSize="sm" color="fg.muted">
                        Loading…
                      </Text>
                    )}
                    {!isLoadingDetail && detail && detail.occurrences.filter((o: JobOccurrenceFull) => o.status !== "ARCHIVED").length === 0 && archivedOccCount === 0 && (
                      <Text fontSize="sm" color="fg.muted">
                        No occurrences yet.
                      </Text>
                    )}
                    {!isLoadingDetail && detail && visibleOccs.map((occ: JobOccurrenceFull) => (
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
                              {occ.windowStart
                                ? new Date(occ.windowStart).toLocaleDateString()
                                : occ.startAt
                                ? new Date(occ.startAt).toLocaleDateString()
                                : "—"}
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              {occ.assignees.length} assignee
                              {occ.assignees.length !== 1 ? "s" : ""}
                            </Text>
                            {occ.price != null && (
                              <Text fontSize="xs" color="fg.muted">
                                Price: ${occ.price.toFixed(2)}
                              </Text>
                            )}
                            {occ.notes && (
                              <Text fontSize="xs" color="fg.muted">
                                {occ.notes}
                              </Text>
                            )}
                          </VStack>
                          <StatusBadge
                            status={occ.status}
                            palette={occurrenceStatusColor(occ.status)}
                            variant="subtle"
                          />
                        </HStack>

                        {forAdmin && job.status === "ACCEPTED" && (
                          <HStack gap={2} mt={2} wrap="wrap">
                            {occ.status !== "CANCELED" && occ.status !== "COMPLETED" && occ.status !== "ARCHIVED" && (
                              <StatusButton
                                id="occ-assignees"
                                itemId={occ.id}
                                label="Assign Workers"
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
                                onClick={async () =>
                                  patchOccurrenceStatus(occ.id, job.id, "IN_PROGRESS")
                                }
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {(occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS") && (
                              <StatusButton
                                id="occ-complete"
                                itemId={occ.id}
                                label="Complete"
                                onClick={async () =>
                                  patchOccurrenceStatus(occ.id, job.id, "COMPLETED")
                                }
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status !== "CANCELED" && occ.status !== "COMPLETED" && occ.status !== "ARCHIVED" && (
                              <StatusButton
                                id="occ-cancel"
                                itemId={occ.id}
                                label="Cancel"
                                onClick={async () =>
                                  patchOccurrenceStatus(occ.id, job.id, "CANCELED")
                                }
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "COMPLETED" && (
                              <StatusButton
                                id="occ-archive"
                                itemId={occ.id}
                                label="Archive"
                                onClick={async () => archiveOccurrence(occ.id, job.id)}
                                variant="outline"
                                colorPalette="gray"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "CANCELED" && (
                              <StatusButton
                                id="occ-delete"
                                itemId={occ.id}
                                label="Delete"
                                onClick={async () => deleteOccurrence(occ.id, job.id)}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "ARCHIVED" && (
                              <StatusButton
                                id="occ-delete-archived"
                                itemId={occ.id}
                                label="Delete"
                                onClick={async () => {
                                  const dateLabel = occ.windowStart
                                    ? new Date(occ.windowStart).toLocaleDateString()
                                    : occ.startAt
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
                            )}
                          </HStack>
                        )}
                      </Box>
                    ))}
                    {!isLoadingDetail && detail && archivedOccCount > 0 && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setShowArchivedOccs((prev) => ({ ...prev, [job.id]: !prev[job.id] }))}
                      >
                        {showArchivedOccs[job.id]
                          ? `Hide archived (${archivedOccCount})`
                          : `Show archived (${archivedOccCount})`}
                      </Button>
                    )}
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
                    {job.status === "ARCHIVED" && (
                      <StatusButton
                        id="job-delete-archived"
                        itemId={job.id}
                        label="Delete"
                        onClick={async () => {
                          setToDelete({
                            deleteType: "archived-job",
                            id: job.id,
                            title: "Delete job?",
                            summary: job.property?.displayName ?? job.id,
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
                    )}
                    {job.status === "PROPOSED" && (
                      <StatusButton
                        id="job-delete"
                        itemId={job.id}
                        label="Delete"
                        onClick={async () => deleteJob(job.id)}
                        variant="outline"
                        colorPalette="red"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                  </HStack>
                </Card.Footer>
              )}
            </Card.Root>
          );
        })}
      </VStack>

      {status === "ARCHIVED" && archivedItems.length < archivedTotal && (
        <HStack justify="center" mt={3}>
          <Button
            variant="outline"
            loading={archivedLoading}
            onClick={() => void loadArchived(archivedPage + 1, false)}
          >
            Load more ({archivedItems.length} of {archivedTotal})
          </Button>
        </HStack>
      )}

      {forAdmin && (
        <JobDialog
          open={jobDialogOpen}
          onOpenChange={setJobDialogOpen}
          mode={editingJob ? "UPDATE" : "CREATE"}
          initial={editingJob}
          onSaved={() => void load()}
        />
      )}

      {forAdmin && (
        <OccurrenceDialog
          open={occurrenceDialogOpen}
          onOpenChange={setOccurrenceDialogOpen}
          jobId={occurrenceJobId}
          defaultNotes={occurrenceDefaultNotes}
          defaultPrice={occurrenceDefaultPrice}
          onSaved={() => {
            if (occurrenceJobId) void loadDetail(occurrenceJobId, true);
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
          onSaved={() => {
            if (assigneeJobId) {
              setJobDetails((prev) => {
                const next = { ...prev };
                delete next[assigneeJobId];
                return next;
              });
              void loadDetail(assigneeJobId);
            }
          }}
        />
      )}
    </Box>
  );
}
