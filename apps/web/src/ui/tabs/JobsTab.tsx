"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  HStack,
  Input,
  Spacer,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import { determineRoles, occurrenceStatusColor, prettyStatus } from "@/src/lib/lib";
import { type TabPropsType, type WorkerOccurrence, JOB_OCCURRENCE_STATUS } from "@/src/lib/types";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import AddAssigneeDialog from "@/src/ui/dialogs/AddAssigneeDialog";
import ScheduleNextDialog from "@/src/ui/dialogs/ScheduleNextDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import AddExpenseDialog from "@/src/ui/dialogs/AddExpenseDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch } from "@/src/lib/bus";

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const filterButtons = ["UNCLAIMED", ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED")] as const;

export default function JobsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isAvail, forAdmin } = determineRoles(me, purpose);
  const myId = me?.id ?? "";

  const [q, setQ] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    new Set(["UNCLAIMED", "SCHEDULED", "IN_PROGRESS", "PENDING_PAYMENT"])
  );

  function toggleFilter(val: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  const [dateFrom, setDateFrom] = useState(() => localDate(new Date()));
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return localDate(d);
  });

  const [manageOpen, setManageOpen] = useState(false);
  const [manageOccurrence, setManageOccurrence] = useState<WorkerOccurrence | null>(null);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    colorPalette: string;
    onConfirm: () => void;
  } | null>(null);

  const [acceptPaymentOpen, setAcceptPaymentOpen] = useState(false);
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<WorkerOccurrence | null>(null);

  const [scheduleNextOpen, setScheduleNextOpen] = useState(false);
  const [scheduleNextData, setScheduleNextData] = useState<{
    jobId: string;
    frequencyDays: number;
    closedOccurrence: { startAt?: string | null; endAt?: string | null; notes?: string | null; price?: number | null };
  } | null>(null);

  const [expenseDialogOccId, setExpenseDialogOccId] = useState<string | null>(null);

  async function deleteExpense(expenseId: string) {
    try {
      await apiDelete(`/api/expenses/${expenseId}`);
      publishInlineMessage({ type: "SUCCESS", text: "Expense deleted." });
      void load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to delete expense.", err),
      });
    }
  }

  async function load(displayLoading = true) {
    setLoading(displayLoading);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const url = `/api/occurrences${qs.toString() ? `?${qs}` : ""}`;
      const list = await apiGet<WorkerOccurrence[]>(url);
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

  async function claim(occurrenceId: string) {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/claim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job claimed." });
      await load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Claim failed.", err),
      });
    }
  }

  async function unclaim(occurrenceId: string) {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/unclaim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job unclaimed." });
      await load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Unclaim failed.", err),
      });
    }
  }

  async function updateStatus(occ: WorkerOccurrence, action: "start" | "complete") {
    try {
      await apiPost(`/api/occurrences/${occ.id}/${action}`, {});
      await load(false);

      // For estimates, "complete" goes straight to CLOSED — prompt schedule next
      if (action === "complete" && occ.isEstimate && occ.job?.frequencyDays && !occ.isOneOff) {
        publishInlineMessage({ type: "SUCCESS", text: "Estimate completed." });
        setScheduleNextData({
          jobId: occ.job.id,
          frequencyDays: occ.job.frequencyDays,
          closedOccurrence: {
            startAt: occ.startAt,
            endAt: occ.endAt,
            notes: occ.notes,
            price: occ.price,
          },
        });
        setScheduleNextOpen(true);
      } else {
        publishInlineMessage({
          type: "SUCCESS",
          text: action === "start" ? "Job started." : "Job marked as pending payment.",
        });
      }
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Action failed.", err),
      });
    }
  }

  const filtered = useMemo(() => {
    let rows = items;
    rows = rows.filter((occ) => {
      if (activeFilters.size === 0) return false;
      const hasAssignees = (occ.assignees ?? []).length > 0;
      if (activeFilters.has("UNCLAIMED") && !hasAssignees) return true;
      if (hasAssignees && activeFilters.has(occ.status)) return true;
      return false;
    });
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
        ]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    return rows;
  }, [items, q, activeFilters]);

  if (!isAvail) return <UnavailableNotice />;

  return (
    <Box w="full">
      <HStack mb={3} gap={3}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="jobs-search"
          placeholder="Search…"
        />
        <Spacer />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load(false)}
          disabled={loading}
        >
          Refresh
        </Button>
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
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            setDateFrom(localDate(yesterday));
            setDateTo(localDate(yesterday));
          }}
        >
          Yesterday
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const today = localDate(new Date());
            setDateFrom(today);
            setDateTo(today);
          }}
        >
          Today
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const today = new Date();
            const future = new Date(today);
            future.setDate(future.getDate() + 2);
            setDateFrom(localDate(today));
            setDateTo(localDate(future));
          }}
        >
          Next 3 days
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDateFrom(localDate(new Date()));
            setDateTo("");
          }}
        >
          Future
        </Button>
      </HStack>

      <HStack mb={3} gap={2} wrap="wrap">
        {filterButtons.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={activeFilters.has(s) ? "solid" : "outline"}
            onClick={() => toggleFilter(s)}
          >
            {s === "UNCLAIMED" ? "Unclaimed" : prettyStatus(s)}
          </Button>
        ))}
      </HStack>

      {loading && <LoadingCenter />}

      {!loading && (
        <VStack align="stretch" gap={3}>
          {filtered.length === 0 && (
            <Box p="8" color="fg.muted">
              No job occurrences match current filters.
            </Box>
          )}

          {filtered.map((occ) => {
            const assignees = occ.assignees ?? [];
            const isAssignedToMe = !!myId && assignees.some((a) => a.userId === myId);
            const isUnassigned = assignees.length === 0;
            const isAssignedToOthers = !isUnassigned && !isAssignedToMe;

            const myAssignee = assignees.find((a) => a.userId === myId);
            const isClaimer = !!myAssignee && myAssignee.assignedById === myId;

            const isTentative = !!occ.isTentative;

            const cardBorderColor = isTentative
              ? "orange.300"
              : isAssignedToMe ? "teal.400" : "gray.200";
            const cardBg = isTentative
              ? "orange.50"
              : isAssignedToMe
              ? "teal.50"
              : isAssignedToOthers
              ? "gray.50"
              : undefined;

            return (
              <Card.Root
                key={occ.id}
                variant="outline"
                borderColor={cardBorderColor}
                bg={cardBg}
              >
                <Card.Header pb="2">
                  <HStack gap={3} justify="space-between" align="center">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontWeight="semibold">
                        {occ.job?.property?.displayName}
                        {occ.job?.property?.client?.displayName && (
                          <> — {occ.job.property.client.displayName}</>
                        )}
                      </Text>
                      <MapLink address={[
                          occ.job?.property?.street1,
                          occ.job?.property?.city,
                          occ.job?.property?.state,
                        ]
                          .filter(Boolean)
                          .join(", ")} />
                      <HStack gap={3}>
                        {occ.job?.property?.displayName && (
                          <TextLink
                            text="View Property"
                            onClick={() =>
                              openEventSearch(
                                "jobsTabToPropertiesTabSearch",
                                occ.job?.property?.displayName ?? "",
                                forAdmin,
                              )
                            }
                          />
                        )}
                        {occ.job?.property?.client?.displayName && (
                          <TextLink
                            text="View Client"
                            onClick={() =>
                              openEventSearch(
                                "jobsTabToClientsTabSearch",
                                occ.job?.property?.client?.displayName ?? "",
                                forAdmin,
                              )
                            }
                          />
                        )}
                      </HStack>
                    </VStack>
                    <VStack gap={1} align="end">
                      <StatusBadge
                        status={occ.status}
                        palette={occurrenceStatusColor(occ.status)}
                        variant="subtle"
                      />
                      {isTentative && (
                        <StatusBadge
                          status="Tentative"
                          palette="orange"
                          variant="subtle"
                        />
                      )}
                      {occ.isEstimate && (
                        <StatusBadge
                          status="Estimate"
                          palette="purple"
                          variant="subtle"
                        />
                      )}
                    </VStack>
                  </HStack>
                </Card.Header>

                <Card.Body pt="0">
                  <VStack align="start" gap={1}>
                    {occ.startAt && (
                      <Text fontSize="sm">
                        {new Date(occ.startAt).toLocaleDateString()}
                        {occ.endAt && new Date(occ.endAt).toLocaleDateString() !== new Date(occ.startAt).toLocaleDateString()
                          ? ` – ${new Date(occ.endAt).toLocaleDateString()}`
                          : ""}
                      </Text>
                    )}
                    {occ.price != null && (
                      <Text fontSize="sm" fontWeight="medium">
                        ${occ.price.toFixed(2)}
                      </Text>
                    )}
                    {occ.notes && (
                      <Text fontSize="sm" color="fg.muted">
                        {occ.notes}
                      </Text>
                    )}

                    {!isUnassigned && (
                      <VStack align="start" gap={0}>
                        {assignees.map((a) => {
                          const isClaimer = a.assignedById === a.userId;
                          const isMe = a.userId === myId;
                          return (
                            <Text
                              key={a.userId}
                              fontSize="xs"
                              fontWeight={isMe ? "semibold" : "normal"}
                              color={isMe ? "teal.600" : "fg.muted"}
                            >
                              {a.user?.displayName ?? a.user?.email ?? a.userId}
                              {isMe ? " (you)" : ""}
                              {isClaimer ? " · Claimer" : ""}
                            </Text>
                          );
                        })}
                      </VStack>
                    )}
                    {isUnassigned && occ.status !== "ARCHIVED" && (
                      <Text fontSize="xs" color="orange.500" fontWeight="medium">
                        {isTentative
                          ? "Tentative — awaiting admin confirmation"
                          : "Unclaimed — available to pick up"}
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

                    {/* Expenses */}
                    {occ.expenses && occ.expenses.length > 0 && (
                      <Box mt={1} p={1} bg="orange.50" rounded="sm" w="full">
                        <Text fontSize="xs" fontWeight="medium" color="orange.700">
                          Expenses: ${occ.expenses.reduce((s, e) => s + e.cost, 0).toFixed(2)}
                        </Text>
                        <VStack align="start" gap={0} mt={0.5}>
                          {occ.expenses.map((exp) => (
                            <HStack key={exp.id} gap={1} w="full">
                              <Text fontSize="xs" color="orange.600" flex="1">
                                ${exp.cost.toFixed(2)} — {exp.description}
                              </Text>
                              {isClaimer && occ.status !== "CLOSED" && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  colorPalette="red"
                                  onClick={() => deleteExpense(exp.id)}
                                >
                                  ✕
                                </Button>
                              )}
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                </Card.Body>

                {(isUnassigned || isAssignedToMe) && !isTentative && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || occ.status === "PENDING_PAYMENT") && (
                  <Card.Footer>
                    <HStack gap={2} wrap="wrap" mb="2">
                      {isUnassigned && (
                        <StatusButton
                          id="occ-claim"
                          itemId={occ.id}
                          label="Claim"
                          onClick={async () => setConfirmAction({
                            title: "Claim Job?",
                            message: "Are you sure you want to claim this job?",
                            confirmLabel: "Claim",
                            colorPalette: "green",
                            onConfirm: () => void claim(occ.id),
                          })}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "SCHEDULED" && (
                        <StatusButton
                          id="occ-start"
                          itemId={occ.id}
                          label="Start"
                          onClick={async () => setConfirmAction({
                            title: "Start Job?",
                            message: "Are you sure you want to start this job?",
                            confirmLabel: "Start",
                            colorPalette: "blue",
                            onConfirm: () => void updateStatus(occ, "start"),
                          })}
                          variant="outline"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "IN_PROGRESS" && (
                        <StatusButton
                          id="occ-complete"
                          itemId={occ.id}
                          label="Complete"
                          onClick={async () => setConfirmAction({
                            title: occ.isEstimate ? "Complete Estimate?" : "Complete Job?",
                            message: occ.isEstimate
                              ? "This estimate will be closed (no payment step)."
                              : "Are you sure you want to mark this job as complete?",
                            confirmLabel: "Complete",
                            colorPalette: "green",
                            onConfirm: () => void updateStatus(occ, "complete"),
                          })}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "PENDING_PAYMENT" && !occ.isEstimate && (
                        <StatusButton
                          id="occ-accept-payment"
                          itemId={occ.id}
                          label="Accept Payment"
                          onClick={async () => {
                            setAcceptPaymentOcc(occ);
                            setAcceptPaymentOpen(true);
                          }}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && occ.status !== "PENDING_PAYMENT" && (
                        <StatusButton
                          id="occ-manage-team"
                          itemId={occ.id}
                          label="Manage Team"
                          onClick={async () => {
                            setManageOccurrence(occ);
                            setManageOpen(true);
                          }}
                          variant="outline"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && (
                        <StatusButton
                          id="occ-add-expense"
                          itemId={occ.id}
                          label="Add Expense"
                          onClick={async () => setExpenseDialogOccId(occ.id)}
                          variant="outline"
                          colorPalette="orange"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && occ.status !== "PENDING_PAYMENT" && (
                        <StatusButton
                          id="occ-unclaim"
                          itemId={occ.id}
                          label="Unclaim"
                          onClick={async () => setConfirmAction({
                            title: "Unclaim Job?",
                            message: "Are you sure you want to unclaim this job?",
                            confirmLabel: "Unclaim",
                            colorPalette: "red",
                            onConfirm: () => void unclaim(occ.id),
                          })}
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
      )}

      {manageOccurrence && (
        <AddAssigneeDialog
          open={manageOpen}
          onOpenChange={(open) => {
            setManageOpen(open);
            if (!open) void load(false);
          }}
          occurrenceId={manageOccurrence.id}
          myId={myId}
          currentAssignees={(manageOccurrence.assignees ?? []).map((a) => ({
            userId: a.userId,
            user: a.user,
          }))}
          onChanged={() => void load(false)}
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
          createEndpoint="/api/occurrences/create-next"
          createBody={{ jobId: scheduleNextData.jobId }}
          onCreated={(nextStartDate) => {
            if (nextStartDate && dateTo && nextStartDate > dateTo) {
              setDateTo(nextStartDate);
            } else {
              void load(false);
            }
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

      <AddExpenseDialog
        open={!!expenseDialogOccId}
        onOpenChange={(o) => { if (!o) setExpenseDialogOccId(null); }}
        endpoint={`/api/occurrences/${expenseDialogOccId}/expenses`}
        onAdded={() => {
          setExpenseDialogOccId(null);
          void load(false);
        }}
      />

      {acceptPaymentOcc && (
        <AcceptPaymentDialog
          open={acceptPaymentOpen}
          onOpenChange={(o) => {
            setAcceptPaymentOpen(o);
            if (!o) setAcceptPaymentOcc(null);
          }}
          endpoint={`/api/occurrences/${acceptPaymentOcc.id}/accept-payment`}
          defaultAmount={acceptPaymentOcc.price}
          assignees={(acceptPaymentOcc.assignees ?? []).map((a) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
          }))}
          onAccepted={() => {
            const occ = acceptPaymentOcc;
            void load(false);
            // Prompt to schedule next if job has frequency and not one-off
            if (occ?.job?.frequencyDays && !occ.isOneOff) {
              setScheduleNextData({
                jobId: occ.job.id,
                frequencyDays: occ.job.frequencyDays,
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
