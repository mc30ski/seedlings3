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
import { apiGet, apiPost } from "@/src/lib/api";
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

const filterButtons = ["UNCLAIMED", ...JOB_OCCURRENCE_STATUS] as const;

export default function JobsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isAvail } = determineRoles(me, purpose);
  const myId = me?.id ?? "";

  const [q, setQ] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    new Set(["UNCLAIMED", "SCHEDULED", "IN_PROGRESS"])
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

  const [dateFrom, setDateFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });

  const [manageOpen, setManageOpen] = useState(false);
  const [manageOccurrence, setManageOccurrence] = useState<WorkerOccurrence | null>(null);

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

  async function updateStatus(occurrenceId: string, action: "start" | "complete") {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/${action}`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: action === "start" ? "Job started." : "Job completed.",
      });
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

            const cardBorderColor = isAssignedToMe ? "teal.400" : "gray.200";
            const cardBg = isAssignedToMe
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
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {[
                          occ.job?.property?.street1,
                          occ.job?.property?.city,
                          occ.job?.property?.state,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </Text>
                    </VStack>
                    <StatusBadge
                      status={occ.status}
                      palette={occurrenceStatusColor(occ.status)}
                      variant="subtle"
                    />
                  </HStack>
                </Card.Header>

                <Card.Body pt="0">
                  <VStack align="start" gap={1}>
                    {occ.windowStart && (
                      <Text fontSize="sm">
                        Window: {new Date(occ.windowStart).toLocaleDateString()}
                        {occ.windowEnd
                          ? ` – ${new Date(occ.windowEnd).toLocaleDateString()}`
                          : ""}
                      </Text>
                    )}
                    {occ.notes && (
                      <Text fontSize="sm" color="fg.muted">
                        {occ.notes}
                      </Text>
                    )}

                    {isAssignedToMe && (
                      <Text fontSize="xs" fontWeight="semibold" color="teal.600">
                        Assigned to you
                        {assignees.length > 1
                          ? ` + ${assignees.length - 1} other${assignees.length - 1 !== 1 ? "s" : ""}`
                          : ""}
                      </Text>
                    )}
                    {isAssignedToOthers && (
                      <Text fontSize="xs" color="fg.muted">
                        Assigned to:{" "}
                        {assignees
                          .map((a) => a.user?.displayName ?? a.user?.email ?? a.userId)
                          .join(", ")}
                      </Text>
                    )}
                    {isUnassigned && occ.status !== "CANCELED" && (
                      <Text fontSize="xs" color="orange.500" fontWeight="medium">
                        Unclaimed — available to pick up
                      </Text>
                    )}
                  </VStack>
                </Card.Body>

                {(isUnassigned || isAssignedToMe) && occ.status !== "COMPLETED" && occ.status !== "CANCELED" && (
                  <Card.Footer>
                    <HStack gap={2} wrap="wrap" mb="2">
                      {isUnassigned && (
                        <StatusButton
                          id="occ-claim"
                          itemId={occ.id}
                          label="Claim"
                          onClick={async () => claim(occ.id)}
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
                          onClick={async () => updateStatus(occ.id, "start")}
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
                          onClick={async () => updateStatus(occ.id, "complete")}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && (
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
                          id="occ-unclaim"
                          itemId={occ.id}
                          label="Unclaim"
                          onClick={async () => unclaim(occ.id)}
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
    </Box>
  );
}
