"use client";

// Admin queue for client-submitted change requests (Reschedule / Skip).
//
// Two action shapes:
//   - SKIP   → one-click "Skip this visit". Cancels the occurrence and (when
//              applicable) advances the recurring chain to the next visit.
//   - RESCHEDULE → no auto-mutation. The admin reaches out to the client via
//              the rendered call/text/email links to find a new time, edits
//              the occurrence date through normal admin tooling, then taps
//              "Mark resolved" here.
//
// Both also have "Decline" to close the request without acting on the
// occurrence (client gets no notification yet — admin should call/text first
// in the decline case too).
//
// Every mutating action is wrapped in ConfirmDialog per the project rule
// against accidental thumb taps.

import { useCallback, useEffect, useState } from "react";
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
import { Calendar, Check, Mail, Phone, RefreshCw, SkipForward, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type ContactBrief = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  normalizedPhone: string | null;
};

type ChangeRequestRow = {
  id: string;
  kind: "RESCHEDULE" | "SKIP";
  status: "PENDING" | "APPROVED" | "DENIED" | "CANCELED";
  comment: string | null;
  /** Client-suggested new date for RESCHEDULE requests. Just a hint —
   *  approving the request does NOT auto-apply this date. */
  proposedStartAt: string | null;
  createdAt: string;
  requestedBy: { id: string; displayName: string | null; email: string | null } | null;
  occurrence: {
    id: string;
    startAt: string | null;
    status: string;
    jobType: string | null;
    workflow: string | null;
    isOneOff: boolean | null;
    frequencyDays: number | null;
    job: {
      id: string;
      frequencyDays: number | null;
      property: {
        id: string;
        displayName: string | null;
        street1: string | null;
        city: string | null;
        state: string | null;
        client: {
          id: string;
          displayName: string | null;
          contacts: ContactBrief[];
        } | null;
      } | null;
    } | null;
  };
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// Date-only formatter. Use for fields the system tracks by day, not
// time-of-day (job startAt, reschedule suggestions, etc.).
function fmtDateOnly(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtRelative(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  } catch {
    return "";
  }
}

function cadenceText(row: ChangeRequestRow): string | null {
  if (row.occurrence.isOneOff || row.occurrence.workflow === "ONE_OFF") return "One-time";
  const f = row.occurrence.frequencyDays ?? row.occurrence.job?.frequencyDays ?? null;
  if (!f || f <= 0) return null;
  if (f === 7) return "Weekly";
  if (f === 14) return "Every 2 weeks";
  if (f === 30) return "Monthly";
  return `Every ${f} days`;
}

function propertyAddress(row: ChangeRequestRow): string | null {
  const p = row.occurrence.job?.property;
  if (!p) return null;
  return [p.street1, p.city, p.state].filter(Boolean).join(", ") || null;
}

function buildOutreachMessage(row: ChangeRequestRow): string {
  const date = fmtDateOnly(row.occurrence.startAt);
  const verb = row.kind === "RESCHEDULE" ? "reschedule" : "skip";
  const firstName = row.occurrence.job?.property?.client?.contacts?.[0]?.firstName ?? "there";
  return `Hi ${firstName}, I got your ${verb} request for ${date}. Wanted to find a date that works for you.`;
}

export default function ClientRequestsSection() {
  const [rows, setRows] = useState<ChangeRequestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingRow, setResolvingRow] = useState<ChangeRequestRow | null>(null);
  const [decliningRow, setDecliningRow] = useState<ChangeRequestRow | null>(null);
  const [skippingRow, setSkippingRow] = useState<ChangeRequestRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<ChangeRequestRow[]>("/api/admin/change-requests?status=PENDING");
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load client requests.", err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function approve(row: ChangeRequestRow) {
    try {
      await apiPost(`/api/admin/change-requests/${row.id}/approve`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: row.kind === "SKIP" ? "Visit skipped." : "Request marked resolved.",
      });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Action failed.", err) });
    }
  }

  async function deny(row: ChangeRequestRow) {
    try {
      await apiPost(`/api/admin/change-requests/${row.id}/deny`, {});
      publishInlineMessage({ type: "INFO", text: "Request declined." });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Action failed.", err) });
    }
  }

  if (loading && rows.length === 0) {
    return (
      <Box p={4} display="flex" justifyContent="center"><Spinner size="md" /></Box>
    );
  }
  if (rows.length === 0) return null;

  return (
    <Box id="client-requests-section" mb={4}>
      <HStack mb={2} justify="space-between">
        <Text fontSize="sm" fontWeight="semibold" color="orange.700">
          Client requests ({rows.length})
        </Text>
        <Button size="xs" variant="ghost" onClick={() => void load()} loading={loading}>
          <RefreshCw size={12} /> Refresh
        </Button>
      </HStack>
      <VStack gap={2} align="stretch">
        {rows.map((row) => {
          const contact = row.occurrence.job?.property?.client?.contacts?.[0] ?? null;
          const clientName = row.occurrence.job?.property?.client?.displayName ?? row.requestedBy?.displayName ?? "—";
          const propName = row.occurrence.job?.property?.displayName ?? "—";
          const addr = propertyAddress(row);
          const cadence = cadenceText(row);
          const outreach = buildOutreachMessage(row);
          const phoneDigits = (contact?.normalizedPhone ?? contact?.phone ?? "").replace(/[^\d+]/g, "");
          const smsHref = phoneDigits
            ? `sms:${phoneDigits}?&body=${encodeURIComponent(outreach)}`
            : null;
          const telHref = phoneDigits ? `tel:${phoneDigits}` : null;
          const mailHref = contact?.email
            ? `mailto:${contact.email}?subject=${encodeURIComponent(
                row.kind === "RESCHEDULE" ? "Rescheduling your service" : "About your skip request"
              )}&body=${encodeURIComponent(outreach)}`
            : null;
          const editJobHref = `/?tab=services&occurrence=${row.occurrence.id}`;
          return (
            <Card.Root
              key={row.id}
              variant="outline"
              borderColor={row.kind === "RESCHEDULE" ? "orange.300" : "purple.300"}
              bg={row.kind === "RESCHEDULE" ? "orange.50" : "purple.50"}
            >
              <Card.Body p={3}>
                <VStack align="stretch" gap={2}>
                  <HStack gap={2} wrap="wrap">
                    <Badge
                      colorPalette={row.kind === "RESCHEDULE" ? "orange" : "purple"}
                      variant="solid"
                      fontSize="xs"
                      borderRadius="full"
                      px="2"
                    >
                      {row.kind === "RESCHEDULE" ? "Reschedule" : "Skip"}
                    </Badge>
                    {cadence && (
                      <Badge colorPalette="blue" variant="subtle" fontSize="xs" borderRadius="full" px="2">
                        {cadence}
                      </Badge>
                    )}
                    {row.occurrence.jobType && (
                      <Badge colorPalette="gray" variant="subtle" fontSize="xs" borderRadius="full" px="2">
                        {row.occurrence.jobType}
                      </Badge>
                    )}
                    <Text fontSize="2xs" color="fg.muted" ml="auto">
                      {fmtRelative(row.createdAt)}
                    </Text>
                  </HStack>

                  <Box>
                    <Text fontSize="sm" fontWeight="medium">{clientName}</Text>
                    <Text fontSize="xs" color="fg.muted">
                      {propName}
                      {addr && <> · {addr}</>}
                    </Text>
                    <Text fontSize="xs" color="fg.muted">
                      Scheduled: {fmtDateOnly(row.occurrence.startAt)}
                    </Text>
                    {row.kind === "RESCHEDULE" && row.proposedStartAt && (
                      <Text fontSize="xs" color="orange.700" fontWeight="medium">
                        Client suggested: {fmtDateOnly(row.proposedStartAt)}
                      </Text>
                    )}
                  </Box>

                  {row.comment && (
                    <Box p={2} bg="white" borderWidth="1px" borderColor="gray.200" rounded="md">
                      <Text fontSize="xs" color="fg.muted" mb={0.5}>Client said:</Text>
                      <Text fontSize="sm">&ldquo;{row.comment}&rdquo;</Text>
                    </Box>
                  )}

                  {/* Reach out */}
                  {(smsHref || telHref || mailHref) && (
                    <Box>
                      <Text fontSize="xs" color="fg.muted" mb={1}>Reach out to {contact?.firstName ?? "client"}:</Text>
                      <HStack gap={1.5} wrap="wrap">
                        {smsHref && (
                          <Button size="xs" variant="outline" colorPalette="teal" asChild>
                            <a href={smsHref}>
                              <Mail size={12} /> Text
                            </a>
                          </Button>
                        )}
                        {telHref && (
                          <Button size="xs" variant="outline" colorPalette="teal" asChild>
                            <a href={telHref}>
                              <Phone size={12} /> Call
                            </a>
                          </Button>
                        )}
                        {mailHref && (
                          <Button size="xs" variant="outline" colorPalette="teal" asChild>
                            <a href={mailHref}>
                              <Mail size={12} /> Email
                            </a>
                          </Button>
                        )}
                      </HStack>
                    </Box>
                  )}
                  {!smsHref && !telHref && !mailHref && (
                    <Text fontSize="xs" color="red.700">
                      No phone or email on the primary contact. Set one before reaching out.
                    </Text>
                  )}

                  {/* Take action */}
                  <Box>
                    <Text fontSize="xs" color="fg.muted" mb={1}>Take action:</Text>
                    <HStack gap={1.5} wrap="wrap">
                      {row.kind === "RESCHEDULE" && (
                        <>
                          <Button size="xs" variant="outline" colorPalette="blue" asChild>
                            <a href={editJobHref}>
                              <Calendar size={12} /> Edit job dates
                            </a>
                          </Button>
                          <Button
                            size="xs"
                            variant="solid"
                            colorPalette="green"
                            onClick={() => setResolvingRow(row)}
                          >
                            <Check size={12} /> Mark resolved
                          </Button>
                        </>
                      )}
                      {row.kind === "SKIP" && (
                        <Button
                          size="xs"
                          variant="solid"
                          colorPalette="purple"
                          onClick={() => setSkippingRow(row)}
                        >
                          <SkipForward size={12} /> Skip this visit
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => setDecliningRow(row)}
                      >
                        <X size={12} /> Decline
                      </Button>
                    </HStack>
                  </Box>
                </VStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>

      <ConfirmDialog
        open={!!resolvingRow}
        title="Mark reschedule resolved?"
        message=""
        warning="This closes the client's request. Edit the job's date through the normal admin editor before marking resolved."
        confirmLabel="Mark resolved"
        confirmColorPalette="green"
        onConfirm={() => { const row = resolvingRow!; setResolvingRow(null); void approve(row); }}
        onCancel={() => setResolvingRow(null)}
      />
      <ConfirmDialog
        open={!!skippingRow}
        title="Skip this visit?"
        message=""
        warning="The occurrence is canceled. For recurring jobs, the next visit will be created on the regular cadence."
        confirmLabel="Skip visit"
        confirmColorPalette="purple"
        onConfirm={() => { const row = skippingRow!; setSkippingRow(null); void approve(row); }}
        onCancel={() => setSkippingRow(null)}
      />
      <ConfirmDialog
        open={!!decliningRow}
        title="Decline this request?"
        message=""
        warning="The job stays as scheduled. Reach out to the client first so they know why."
        confirmLabel="Decline"
        confirmColorPalette="red"
        onConfirm={() => { const row = decliningRow!; setDecliningRow(null); void deny(row); }}
        onCancel={() => setDecliningRow(null)}
      />
    </Box>
  );
}
