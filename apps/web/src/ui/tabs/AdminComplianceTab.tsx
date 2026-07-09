"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle, Archive, CheckCircle2, ChevronRight, Download, Eye, FileText, Play, Plus, RotateCcw, Trash2, X, XCircle } from "lucide-react";
import PolicyMarkdown from "@/src/ui/components/PolicyMarkdown";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import { bizDateKey, bizToday, fmtDate } from "@/src/lib/lib";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import WorkerPicker from "@/src/ui/components/WorkerPicker";

// ─────────────────────────────────────────────────────────────────────────────
// Human-facing labels for the enum values the backend uses. The DB stores
// values like "BLOCK" / "DAYS_SINCE_SIGN" — these render as plain English in
// the UI. The KEYS list stays authoritative; if you add a new enum value in
// prisma/schema.prisma, add a label here too (typecheck will flag missing).
// ─────────────────────────────────────────────────────────────────────────────

const ENFORCEMENT_LABEL: Record<"BLOCK" | "WARN" | "INFO", string> = {
  BLOCK: "Block",
  WARN: "Warn",
  INFO: "Info only",
};
const ENFORCEMENT_HELP: Record<"BLOCK" | "WARN" | "INFO", string> = {
  BLOCK: "Worker can't start work or claim jobs until they complete this policy.",
  WARN: "Worker sees a banner but can keep working.",
  INFO: "Shown in the Compliance tab only. No banner, no block.",
};

const WORKER_ACTION_LABEL: Record<"SIGN" | "ACKNOWLEDGE" | "NONE", string> = {
  SIGN: "Sign (type name)",
  ACKNOWLEDGE: "Acknowledge",
  NONE: "No action (admin only)",
};
const WORKER_ACTION_HELP: Record<"SIGN" | "ACKNOWLEDGE" | "NONE", string> = {
  SIGN: "Worker types their name to sign.",
  ACKNOWLEDGE: "Worker taps one button to acknowledge — no typed name.",
  NONE: "Worker never touches this policy. Admin uploads on their behalf.",
};

const WORKER_TYPE_LABEL: Record<"EMPLOYEE" | "CONTRACTOR" | "TRAINEE", string> = {
  EMPLOYEE: "Employee",
  CONTRACTOR: "Contractor",
  TRAINEE: "Trainee",
};

const RESIGN_TRIGGER_LABEL: Record<string, string> = {
  ONE_TIME: "Sign once",
  DAYS_SINCE_SIGN: "Every N days",
  // Both enum values render as "Yearly." ANNIVERSARY is legacy — kept in the
  // map so any older row still displays a sensible label; new UI writes
  // ANNUAL_ON_DATE only (with optional MM-DD).
  ANNIVERSARY: "Yearly",
  ANNUAL_ON_DATE: "Yearly",
};

const NOTIFY_LABEL: Record<string, string> = {
  PUSH_ONLY: "Push notification only",
  ALL_CHANNELS: "Push + email",
};

const GATE_SERVICE_LABEL: Record<string, string> = {
  WORKDAY_START: "Start a workday",
  JOB_CLAIM: "Claim a job",
  RESERVE_EQUIPMENT: "Claim equipment",
};

const VERSION_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  PUBLISHED: "Published",
  ROLLED_BACK: "Rolled back",
};

// Validate an MM-DD string for the ANNUAL_ON_DATE trigger. Returns an
// error string when invalid, empty string when valid or empty. Accepts
// 02-29 because the predicate falls back to 02-28 on non-leap years.
function validateMonthDay(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (!/^\d{2}-\d{2}$/.test(trimmed)) {
    return "Use two-digit format like 01-15 (month-day).";
  }
  const [monthStr, dayStr] = trimmed.split("-");
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12) {
    return "Month must be between 01 and 12.";
  }
  // Days per month — Feb allows 29 for leap-year support.
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > maxDay) {
    return `Day must be between 01 and ${String(maxDay).padStart(2, "0")} for month ${monthStr}.`;
  }
  return "";
}

function resignTriggerDetail(
  trigger: string,
  days: number | null | undefined,
  monthDay: string | null | undefined,
): string {
  if (trigger === "DAYS_SINCE_SIGN" && days) return `every ${days} days`;
  if ((trigger === "ANNIVERSARY" || trigger === "ANNUAL_ON_DATE") && monthDay) {
    return `on ${monthDay} each year`;
  }
  return "";
}

// Convert between the DB's `MM-DD` format and the HTML date input's
// `YYYY-MM-DD` format. Year is arbitrary — only month+day is stored.
function monthDayToDateInput(monthDay: string | null): string {
  if (!monthDay || !/^\d{2}-\d{2}$/.test(monthDay)) return "";
  return `2000-${monthDay}`;
}
function dateInputToMonthDay(dateInput: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return "";
  return dateInput.slice(5); // MM-DD portion
}

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror GET /admin/policies response)
// ─────────────────────────────────────────────────────────────────────────────

type PolicyListRow = {
  id: string;
  key: string;
  title: string;
  description: string | null;
  enforcement: "BLOCK" | "WARN" | "INFO";
  workerAction: "SIGN" | "ACKNOWLEDGE" | "NONE";
  targetWorkerTypes: string[];
  currentVersionId: string | null;
  currentVersion: {
    id: string;
    versionNumber: number;
    contentFormat: "MARKDOWN" | "PDF";
    status: string;
  } | null;
  sortOrder: number;
  archivedAt: string | null;
  _count: { versions: number; exceptions: number };
  // Per-status version counts, powering the pipeline chips on each list
  // card so operators see pending work without opening every drawer.
  draftCount: number;
  pendingApprovalCount: number;
  approvedCount: number;
};

type VersionRow = {
  id: string;
  versionNumber: number;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "PUBLISHED" | "ROLLED_BACK";
  contentFormat: "MARKDOWN" | "PDF";
  contentMarkdown: string | null;
  contentDigest: string;
  changeNote: string;
  forcesResign: boolean;
  createdAt: string;
  publishedAt: string | null;
  createdBy: { id: string; displayName: string | null };
  approvedBy: { id: string; displayName: string | null } | null;
  publishedBy: { id: string; displayName: string | null } | null;
};

type PolicyDetail = PolicyListRow & {
  versions: VersionRow[];
  exceptions: Array<{
    id: string;
    userId: string;
    expiresAt: string;
    reason: string;
    user: { id: string; displayName: string | null };
  }>;
  adminCanUploadOnBehalf: boolean;
  requiresWorkerUpload: boolean;
  workerUploadLabel: string | null;
  workerUploadAcceptedTypes: string | null;
  workerUploadRequiresExpiry: boolean;
  workerUploadRequiresApproval: boolean;
  resignTrigger: string;
  resignParamDays: number | null;
  resignParamMonthDay: string | null;
  gatesServices: string[];
  gatesJobsAbovePrice: number | null;
  notifyOnPublish: string;
  graceHoursOverride: number | null;
};

type PendingUploadReview = {
  id: string;
  signedAt: string;
  user: { id: string; displayName: string | null; email: string | null };
  version: {
    id: string;
    versionNumber: number;
    policyDocument: { id: string; title: string; key: string };
  };
  uploadFileName: string | null;
  uploadContentType: string | null;
  uploadR2Key: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main tab
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminComplianceTab() {
  const [policies, setPolicies] = useState<PolicyListRow[]>([]);
  const [pendingUploadReviews, setPendingUploadReviews] = useState<PendingUploadReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [view, setView] = useState<"list" | "matrix">("list");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, reviews] = await Promise.all([
        apiGet<PolicyListRow[]>(`/api/admin/policies?includeArchived=${showArchived}`),
        apiGet<PendingUploadReview[]>("/api/admin/policies/pending-upload-reviews"),
      ]);
      setPolicies(list);
      setPendingUploadReviews(reviews);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load policies.", err) });
    }
    setLoading(false);
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Box w="full" pb={8}>
      <HStack justify="space-between" mb={3} wrap="wrap" gap={2} align="center">
        <HStack gap={3} align="center" flexWrap="wrap">
          <VStack align="start" gap={0}>
            <Text fontSize="lg" fontWeight="semibold">
              Compliance policies
            </Text>
            <Text fontSize="xs" color="fg.muted">
              Documents workers must sign / acknowledge / have on file.
            </Text>
          </VStack>
          <HStack gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
            <Button
              size="sm"
              variant={view === "list" ? "solid" : "ghost"}
              onClick={() => setView("list")}
              borderRadius="0"
            >
              Policies
            </Button>
            <Button
              size="sm"
              variant={view === "matrix" ? "solid" : "ghost"}
              onClick={() => setView("matrix")}
              borderRadius="0"
            >
              Sign matrix
            </Button>
          </HStack>
        </HStack>
        {view === "list" && (
          <HStack gap={2} flexWrap="wrap" justify={{ base: "flex-start", md: "flex-end" }}>
            <Button
              size="sm"
              variant={showArchived ? "solid" : "outline"}
              onClick={() => setShowArchived(!showArchived)}
            >
              <Archive size={14} /> {showArchived ? "Hide archived" : "Show archived"}
            </Button>
            <Button size="sm" colorPalette="blue" onClick={() => setCreateDialogOpen(true)}>
              <Plus size={14} /> New policy
            </Button>
          </HStack>
        )}
      </HStack>

      {view === "matrix" && <SignMatrixView />}

      {view === "list" && (
        <>
      {pendingUploadReviews.length > 0 && (
        <Card.Root variant="outline" mb={3} borderColor="orange.400">
          <Card.Body p={3}>
            <HStack justify="space-between" mb={2}>
              <HStack gap={2}>
                <Text fontSize="sm" fontWeight="semibold">
                  Uploads awaiting review
                </Text>
                <Badge size="sm" colorPalette="orange" variant="solid">
                  {pendingUploadReviews.length}
                </Badge>
              </HStack>
            </HStack>
            <VStack align="stretch" gap={1}>
              {pendingUploadReviews.map((r) => (
                <UploadReviewRow key={r.id} row={r} onReviewed={() => void load()} />
              ))}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {loading && policies.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Spinner />
        </Box>
      ) : policies.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Text color="fg.muted" fontSize="sm">
            No policies yet. Create the first one to start managing compliance.
          </Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={2}>
          {policies.map((p) => (
            <PolicyListItem
              key={p.id}
              policy={p}
              onClick={() => setSelectedPolicyId(p.id)}
            />
          ))}
        </VStack>
      )}

        </>
      )}

      {selectedPolicyId && (
        <PolicyDetailDrawer
          policyId={selectedPolicyId}
          onClose={() => setSelectedPolicyId(null)}
          onChanged={() => void load()}
        />
      )}

      {createDialogOpen && (
        <PolicyCreateDialog
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => {
            setCreateDialogOpen(false);
            void load();
          }}
        />
      )}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy list row
// ─────────────────────────────────────────────────────────────────────────────

function PolicyListItem({ policy, onClick }: { policy: PolicyListRow; onClick: () => void }) {
  return (
    <Card.Root
      variant="outline"
      cursor="pointer"
      onClick={onClick}
      _hover={{ borderColor: "blue.300", bg: "gray.50" }}
      opacity={policy.archivedAt ? 0.6 : 1}
    >
      <Card.Body p={3}>
        <HStack gap={3} align="center">
          <VStack align="start" gap={0.5} flex="1" minW={0}>
            <HStack gap={2} wrap="wrap">
              <Text fontSize="sm" fontWeight="semibold">
                {policy.title}
              </Text>
              <Badge size="xs" colorPalette="gray" variant="outline">
                {policy.key}
              </Badge>
              <Badge
                size="xs"
                colorPalette={policy.enforcement === "BLOCK" ? "red" : policy.enforcement === "WARN" ? "orange" : "blue"}
                variant="subtle"
              >
                {ENFORCEMENT_LABEL[policy.enforcement]}
              </Badge>
              <Badge size="xs" colorPalette="gray" variant="subtle">
                {WORKER_ACTION_LABEL[policy.workerAction]}
              </Badge>
              {policy.archivedAt && (
                <Badge size="xs" colorPalette="gray" variant="solid">
                  Archived
                </Badge>
              )}
              {!policy.currentVersionId && !policy.archivedAt && (
                <Badge size="xs" colorPalette="orange" variant="solid" title="No version has been published yet — workers can't see this policy.">
                  Never published
                </Badge>
              )}
              {policy.currentVersion?.status === "PUBLISHED" && !policy.archivedAt && (
                <Badge size="xs" colorPalette="green" variant="solid" title={`Currently live to workers — v${policy.currentVersion.versionNumber}.`}>
                  Published v{policy.currentVersion.versionNumber}
                </Badge>
              )}
              {policy.approvedCount > 0 && (
                <Badge size="xs" colorPalette="cyan" variant="solid" title="Version(s) approved and ready to publish.">
                  <Play size={10} /> {policy.approvedCount} ready to publish
                </Badge>
              )}
              {policy.pendingApprovalCount > 0 && (
                <Badge size="xs" colorPalette="purple" variant="solid" title="Version(s) submitted; waiting for a second admin to approve.">
                  {policy.pendingApprovalCount} awaiting approval
                </Badge>
              )}
              {policy.draftCount > 0 && (
                <Badge size="xs" colorPalette="yellow" variant="solid" title="Draft version(s) in progress; not yet submitted for approval.">
                  {policy.draftCount} draft
                </Badge>
              )}
            </HStack>
            {policy.description && (
              <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                {policy.description}
              </Text>
            )}
            <HStack gap={2} fontSize="2xs" color="fg.muted">
              <Text>{policy.targetWorkerTypes.length > 0 ? policy.targetWorkerTypes.map((t) => WORKER_TYPE_LABEL[t as "EMPLOYEE" | "CONTRACTOR" | "TRAINEE"] ?? t).join(", ") : "(all)"}</Text>
              <Text>·</Text>
              <Text>
                v{policy.currentVersion?.versionNumber ?? "?"} · {policy._count.versions} version
                {policy._count.versions === 1 ? "" : "s"}
              </Text>
              {policy._count.exceptions > 0 && (
                <>
                  <Text>·</Text>
                  <Text>
                    {policy._count.exceptions} exception{policy._count.exceptions === 1 ? "" : "s"}
                  </Text>
                </>
              )}
            </HStack>
          </VStack>
          <ChevronRight size={16} color="var(--chakra-colors-fg-muted)" />
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail drawer — everything about one policy: versions, actions, exceptions
// ─────────────────────────────────────────────────────────────────────────────

function PolicyDetailDrawer({
  policyId,
  onClose,
  onChanged,
}: {
  policyId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<PolicyDetail | null>(null);
  const [defaultGraceHours, setDefaultGraceHours] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [newVersionDialogOpen, setNewVersionDialogOpen] = useState(false);
  const [uploadOnBehalfOpen, setUploadOnBehalfOpen] = useState(false);
  const [exceptionDialogOpen, setExceptionDialogOpen] = useState(false);
  const [editMetadataOpen, setEditMetadataOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<VersionRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "rollback"; versionId: string; versionNumber: number }
    | { kind: "archive" }
    | { kind: "delete-permanent" }
    | { kind: "force-resign" }
    | { kind: "revoke-exception"; exceptionId: string; userName: string }
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, settings] = await Promise.all([
        apiGet<PolicyDetail>(`/api/admin/policies/${policyId}`),
        // Fetch settings so the drawer can display the system-wide default
        // grace hours in parens when a policy inherits it. Silent-fail: the
        // metadata card still renders; the parens just get omitted.
        apiGet<Array<{ key: string; value: string }>>(`/api/admin/settings`).catch(
          () => [] as Array<{ key: string; value: string }>,
        ),
      ]);
      setDetail(d);
      const raw = settings.find((s) => s.key === "POLICY_DEFAULT_GRACE_HOURS")?.value;
      const parsed = raw ? Number(raw) : NaN;
      setDefaultGraceHours(Number.isFinite(parsed) ? parsed : 24);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load policy.", err) });
    }
    setLoading(false);
  }, [policyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function withBusy(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Action failed.", err) });
    } finally {
      setBusy(null);
    }
  }

  async function submitVersion(versionId: string) {
    await withBusy(`submit-${versionId}`, () =>
      apiPost(`/api/admin/policies/versions/${versionId}/submit`, {}),
    );
  }
  async function approveVersion(versionId: string) {
    await withBusy(`approve-${versionId}`, () =>
      apiPost(`/api/admin/policies/versions/${versionId}/approve`, {}),
    );
  }
  async function publishVersion(versionId: string) {
    await withBusy(`publish-${versionId}`, () =>
      apiPost(`/api/admin/policies/versions/${versionId}/publish`, {}),
    );
  }
  function askRollbackVersion(versionId: string, versionNumber: number) {
    setConfirm({ kind: "rollback", versionId, versionNumber });
  }
  function askArchive() {
    setConfirm({ kind: "archive" });
  }
  function askForceResign() {
    setConfirm({ kind: "force-resign" });
  }
  function askRevokeException(exceptionId: string, userName: string) {
    setConfirm({ kind: "revoke-exception", exceptionId, userName });
  }
  async function unarchive() {
    await withBusy("unarchive", () =>
      apiPost(`/api/admin/policies/${policyId}/unarchive`, {}),
    );
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="3xl" w="full" rounded="2xl" p={0} maxH="90vh" display="flex" flexDirection="column">
            <Dialog.Header px={4} py={3} borderBottomWidth="1px">
              <HStack justify="space-between" w="full">
                <VStack align="start" gap={0}>
                  <Dialog.Title fontSize="md">{detail?.title ?? "…"}</Dialog.Title>
                  {detail && (
                    <HStack gap={2}>
                      <Badge size="xs" colorPalette="gray" variant="outline">
                        {detail.key}
                      </Badge>
                      <Badge
                        size="xs"
                        colorPalette={detail.enforcement === "BLOCK" ? "red" : detail.enforcement === "WARN" ? "orange" : "blue"}
                        variant="subtle"
                      >
                        {ENFORCEMENT_LABEL[detail.enforcement]}
                      </Badge>
                      <Badge size="xs" colorPalette="gray" variant="subtle">
                        {WORKER_ACTION_LABEL[detail.workerAction]}
                      </Badge>
                    </HStack>
                  )}
                </VStack>
                <Button size="xs" variant="ghost" onClick={onClose}>
                  <X size={14} />
                </Button>
              </HStack>
            </Dialog.Header>
            <Dialog.Body overflowY="auto" flex="1" px={4} py={3}>
              {loading || !detail ? (
                <HStack justify="center" py={6}><Spinner /></HStack>
              ) : (
                <VStack align="stretch" gap={4}>
                  {/* Metadata summary */}
                  <Card.Root variant="outline">
                    <Card.Body p={3}>
                      <VStack align="stretch" gap={1} fontSize="xs">
                        {detail.description && <Text color="fg.default">{detail.description}</Text>}
                        <Text color="fg.muted">
                          <b>Applies to:</b>{" "}
                          {detail.targetWorkerTypes.length > 0
                            ? detail.targetWorkerTypes
                                .map((t) => WORKER_TYPE_LABEL[t as "EMPLOYEE" | "CONTRACTOR" | "TRAINEE"] ?? t)
                                .join(", ")
                            : "everyone"}
                        </Text>
                        <Text color="fg.muted">
                          <b>How often to re-sign:</b>{" "}
                          {RESIGN_TRIGGER_LABEL[detail.resignTrigger] ?? detail.resignTrigger}
                          {resignTriggerDetail(
                            detail.resignTrigger,
                            detail.resignParamDays,
                            detail.resignParamMonthDay,
                          )
                            ? ` — ${resignTriggerDetail(
                                detail.resignTrigger,
                                detail.resignParamDays,
                                detail.resignParamMonthDay,
                              )}`
                            : ""}
                        </Text>
                        <Text color="fg.muted">
                          <b>Blocks:</b>{" "}
                          {detail.gatesServices.length > 0
                            ? detail.gatesServices.map((s) => GATE_SERVICE_LABEL[s] ?? s).join(", ")
                            : "nothing (no action gates set)"}
                          {detail.gatesJobsAbovePrice
                            ? ` — job-claim gate only fires above $${detail.gatesJobsAbovePrice}`
                            : ""}
                        </Text>
                        <Text color="fg.muted">
                          <b>Notify workers when a new version is published:</b>{" "}
                          {NOTIFY_LABEL[detail.notifyOnPublish] ?? detail.notifyOnPublish}
                        </Text>
                        <Text color="fg.muted">
                          <b>Grace after publish:</b>{" "}
                          {detail.graceHoursOverride === null
                            ? `system default${
                                defaultGraceHours !== null
                                  ? ` (${defaultGraceHours} hour${defaultGraceHours === 1 ? "" : "s"})`
                                  : ""
                              }`
                            : detail.graceHoursOverride === 0
                              ? "none (blocks immediately)"
                              : `${detail.graceHoursOverride} hour${detail.graceHoursOverride === 1 ? "" : "s"}`}
                        </Text>
                        {detail.requiresWorkerUpload && (
                          <Text color="fg.muted">
                            <b>Worker upload:</b> {detail.workerUploadLabel}
                            {detail.workerUploadRequiresExpiry ? " (expiry req.)" : ""}
                            {detail.workerUploadRequiresApproval ? " (review req.)" : ""}
                          </Text>
                        )}
                        {detail.adminCanUploadOnBehalf && (
                          <Text color="fg.muted">
                            <b>Admin upload on behalf:</b> enabled
                          </Text>
                        )}
                      </VStack>
                    </Card.Body>
                  </Card.Root>

                  {/* Action strip */}
                  <HStack gap={2} wrap="wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setNewVersionDialogOpen(true)}
                      disabled={!!detail.archivedAt}
                    >
                      <Plus size={12} /> New version
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditMetadataOpen(true)}
                      disabled={!!detail.archivedAt}
                    >
                      <FileText size={12} /> Edit metadata
                    </Button>
                    {detail.adminCanUploadOnBehalf && (
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="blue"
                        onClick={() => setUploadOnBehalfOpen(true)}
                        disabled={!!detail.archivedAt}
                      >
                        <FileText size={12} /> Upload on behalf
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setExceptionDialogOpen(true)}
                      disabled={!!detail.archivedAt}
                    >
                      <Plus size={12} /> Grant exception
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="red"
                      onClick={askForceResign}
                      loading={busy === "force-resign"}
                      disabled={!!detail.archivedAt}
                    >
                      <AlertTriangle size={12} /> Force re-sign all
                    </Button>
                    {detail.archivedAt ? (
                      <>
                        <Button size="sm" variant="outline" onClick={unarchive} loading={busy === "unarchive"}>
                          Unarchive
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          onClick={() => setConfirm({ kind: "delete-permanent" })}
                          loading={busy === "delete-permanent"}
                        >
                          <Trash2 size={12} /> Delete permanently
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" colorPalette="gray" onClick={askArchive} loading={busy === "archive"}>
                        <Archive size={12} /> Archive
                      </Button>
                    )}
                  </HStack>

                  {/* Versions */}
                  <Box>
                    <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                      VERSIONS
                    </Text>
                    <VStack align="stretch" gap={1}>
                      {detail.versions.map((v) => (
                        <VersionRow
                          key={v.id}
                          version={v}
                          isCurrent={v.id === detail.currentVersionId}
                          busy={busy}
                          onSubmit={() => submitVersion(v.id)}
                          onApprove={() => approveVersion(v.id)}
                          onPublish={() => publishVersion(v.id)}
                          onRollback={() => askRollbackVersion(v.id, v.versionNumber)}
                          onPreview={() => setPreviewVersion(v)}
                        />
                      ))}
                    </VStack>
                  </Box>

                  {/* Exceptions */}
                  {detail.exceptions.length > 0 && (
                    <Box>
                      <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                        ACTIVE EXCEPTIONS
                      </Text>
                      <VStack align="stretch" gap={1}>
                        {detail.exceptions.map((ex) => (
                          <HStack
                            key={ex.id}
                            p={2}
                            borderWidth="1px"
                            borderColor="yellow.200"
                            bg="yellow.50"
                            borderRadius="md"
                            gap={2}
                            fontSize="xs"
                          >
                            <Text fontWeight="medium" flex="1">
                              {ex.user.displayName ?? ex.userId}
                            </Text>
                            <Text color="fg.muted">
                              until {new Date(ex.expiresAt).toLocaleDateString()}
                            </Text>
                            <Text color="fg.muted" flex="1" lineClamp={1}>
                              {ex.reason}
                            </Text>
                            <Button
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              onClick={() => askRevokeException(ex.id, ex.user.displayName ?? ex.userId)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          </HStack>
                        ))}
                      </VStack>
                    </Box>
                  )}
                </VStack>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
      {newVersionDialogOpen && detail && (
        <NewVersionDialog
          policyId={detail.id}
          onClose={() => setNewVersionDialogOpen(false)}
          onCreated={() => {
            setNewVersionDialogOpen(false);
            void load();
          }}
        />
      )}
      {uploadOnBehalfOpen && detail && (
        <AdminUploadOnBehalfDialog
          policy={detail}
          onClose={() => setUploadOnBehalfOpen(false)}
          onUploaded={() => {
            setUploadOnBehalfOpen(false);
            void load();
            onChanged();
          }}
        />
      )}
      {exceptionDialogOpen && detail && (
        <GrantExceptionDialog
          policyId={detail.id}
          policyTitle={detail.title}
          onClose={() => setExceptionDialogOpen(false)}
          onGranted={() => {
            setExceptionDialogOpen(false);
            void load();
            onChanged();
          }}
        />
      )}
      {editMetadataOpen && detail && (
        <EditPolicyMetadataDialog
          policy={detail}
          onClose={() => setEditMetadataOpen(false)}
          onSaved={() => {
            setEditMetadataOpen(false);
            void load();
            onChanged();
          }}
        />
      )}
      {previewVersion && detail && (
        <VersionPreviewDialog
          policy={detail}
          version={previewVersion}
          onClose={() => setPreviewVersion(null)}
        />
      )}
      <ConfirmDialog
        open={confirm?.kind === "rollback"}
        title="Roll back this version?"
        message={
          confirm?.kind === "rollback"
            ? `Rolling back v${confirm.versionNumber} clears its PUBLISHED status. If it's the current version, workers will fall back to the prior published version.`
            : ""
        }
        confirmLabel="Roll back"
        confirmColorPalette="red"
        inputPlaceholder="e.g. Typo in section 3"
        inputLabel="Rollback reason"
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          if (confirm?.kind !== "rollback") return;
          const versionId = confirm.versionId;
          setConfirm(null);
          await withBusy(`rollback-${versionId}`, () =>
            apiPost(`/api/admin/policies/versions/${versionId}/rollback`, { reason }),
          );
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        title="Archive this policy?"
        message="Archived policies stop appearing in worker views and matrix. Existing signatures remain in the audit trail. You can unarchive later."
        confirmLabel="Archive"
        confirmColorPalette="red"
        inputPlaceholder="e.g. Superseded by new HR handbook"
        inputLabel="Archive reason"
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          setConfirm(null);
          await withBusy("archive", () =>
            apiPost(`/api/admin/policies/${policyId}/archive`, { reason }),
          );
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete-permanent"}
        title={detail ? `Permanently delete "${detail.title}"?` : "Permanently delete this policy?"}
        message={
          detail
            ? `This destroys the policy plus every version, signature, and exception attached to it. This action cannot be undone. Type DELETE to confirm.`
            : ""
        }
        messageNode={
          detail ? (
            <>
              <Text mb={2}>
                This <b>permanently destroys</b> the policy plus everything attached to it:
              </Text>
              <VStack align="stretch" gap={0.5} pl={4} mb={2} fontSize="sm">
                <Text>
                  • <b>{detail.versions.length}</b> version{detail.versions.length === 1 ? "" : "s"}
                </Text>
                <Text>
                  • Every signature ever recorded against this policy
                </Text>
                <Text>
                  • <b>{detail.exceptions.length}</b> active exception{detail.exceptions.length === 1 ? "" : "s"}
                </Text>
              </VStack>
              <Text fontSize="sm" color="red.700" mb={2}>
                This cannot be undone. Consider leaving it archived instead — archive preserves the audit trail forever.
              </Text>
              <Text fontSize="sm">Type <b>DELETE</b> below to confirm.</Text>
            </>
          ) : undefined
        }
        confirmLabel="Delete permanently"
        confirmColorPalette="red"
        requiredInputValue="DELETE"
        inputPlaceholder="Type DELETE to confirm"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          try {
            setBusy("delete-permanent");
            await apiDelete(`/api/admin/policies/${policyId}/permanent`);
            publishInlineMessage({ type: "SUCCESS", text: "Policy deleted permanently." });
            onChanged();
            onClose();
          } catch (err) {
            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
          } finally {
            setBusy(null);
          }
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "force-resign"}
        title={detail ? `Force re-sign all workers on "${detail.title}"?` : "Force re-sign all workers?"}
        message="This revokes every current signature on this policy. Every targeted worker will be prompted to re-sign on their next app open."
        warning="Use only when the change is legally material — a typo fix should ship as a normal new version instead."
        confirmLabel="Force re-sign all"
        confirmColorPalette="red"
        inputPlaceholder="e.g. Insurance limits raised per state law"
        inputLabel="Reason (shown to workers)"
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          setConfirm(null);
          await withBusy("force-resign", () =>
            apiPost(`/api/admin/policies/${policyId}/force-resign`, { reason }),
          );
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "revoke-exception"}
        title="Revoke this exception?"
        message={
          confirm?.kind === "revoke-exception"
            ? `Revoking ${confirm.userName}'s exception restores the normal compliance requirement immediately.`
            : ""
        }
        confirmLabel="Revoke"
        confirmColorPalette="red"
        inputPlaceholder="e.g. Onboarding complete — no longer needed"
        inputLabel="Revoke reason"
        onCancel={() => setConfirm(null)}
        onConfirm={async (reason) => {
          if (confirm?.kind !== "revoke-exception") return;
          const exceptionId = confirm.exceptionId;
          setConfirm(null);
          try {
            await apiDelete(`/api/admin/policies/exceptions/${exceptionId}`, { reason });
            await load();
            onChanged();
          } catch (err) {
            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Revoke failed.", err) });
          }
        }}
      />
    </Dialog.Root>
  );
}

function VersionRow({
  version,
  isCurrent,
  busy,
  onSubmit,
  onApprove,
  onPublish,
  onRollback,
  onPreview,
}: {
  version: VersionRow;
  isCurrent: boolean;
  busy: string | null;
  onSubmit: () => void;
  onApprove: () => void;
  onPublish: () => void;
  onRollback: () => void;
  onPreview: () => void;
}) {
  // A version's DB status can be PUBLISHED even after a newer version
  // supersedes it. Show "Superseded" (gray) for previously-published-but-
  // no-longer-current versions so the admin doesn't see two green
  // "Published" chips on the same policy — only the current one wears the
  // live-to-workers green badge.
  const isSuperseded = version.status === "PUBLISHED" && !isCurrent;
  const displayStatus = isSuperseded ? "SUPERSEDED" : version.status;
  const statusColor =
    displayStatus === "PUBLISHED" ? "green" :
    displayStatus === "APPROVED" ? "cyan" :
    displayStatus === "PENDING_APPROVAL" ? "purple" :
    displayStatus === "ROLLED_BACK" ? "red" :
    displayStatus === "SUPERSEDED" ? "gray" :
    displayStatus === "DRAFT" ? "yellow" :
    "gray";
  const statusVariant =
    displayStatus === "PUBLISHED" ? "solid" :
    displayStatus === "DRAFT" ? "solid" :
    "subtle";
  return (
    <Card.Root variant="outline">
      <Card.Body p={2}>
        <HStack justify="space-between" wrap="wrap" gap={2}>
          <VStack align="start" gap={0} flex="1" minW="200px">
            <HStack gap={2}>
              <Text fontSize="sm" fontWeight="semibold">
                v{version.versionNumber}
              </Text>
              <Badge size="xs" colorPalette={statusColor} variant={statusVariant}>
                {isSuperseded ? "Superseded" : VERSION_STATUS_LABEL[version.status] ?? version.status}
              </Badge>
              {isCurrent && (
                <Badge size="xs" colorPalette="green" variant="outline">
                  current
                </Badge>
              )}
              <Badge size="xs" colorPalette="gray" variant="outline">
                {version.contentFormat}
              </Badge>
              {version.forcesResign && (
                <Badge size="xs" colorPalette="orange" variant="subtle">
                  forces re-sign
                </Badge>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted" lineClamp={1}>
              {version.changeNote}
            </Text>
            <Text fontSize="2xs" color="fg.muted">
              digest {version.contentDigest.slice(0, 12)}… · by {version.createdBy.displayName ?? "?"}
              {version.publishedAt && ` · published ${new Date(version.publishedAt).toLocaleDateString()}`}
            </Text>
          </VStack>
          <HStack gap={1}>
            <Button size="xs" variant="ghost" onClick={onPreview} title="Preview as worker">
              <Eye size={10} /> Preview
            </Button>
            {version.status === "DRAFT" && (
              <Button size="xs" variant="outline" onClick={onSubmit} loading={busy === `submit-${version.id}`}>
                Submit
              </Button>
            )}
            {version.status === "PENDING_APPROVAL" && (
              <Button size="xs" variant="outline" colorPalette="blue" onClick={onApprove} loading={busy === `approve-${version.id}`}>
                Approve
              </Button>
            )}
            {version.status === "APPROVED" && (
              <Button size="xs" colorPalette="green" onClick={onPublish} loading={busy === `publish-${version.id}`}>
                <Play size={10} /> Publish
              </Button>
            )}
            {version.status === "PUBLISHED" && (
              <Button size="xs" variant="outline" colorPalette="red" onClick={onRollback} loading={busy === `rollback-${version.id}`}>
                <RotateCcw size={10} /> Rollback
              </Button>
            )}
          </HStack>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create-policy dialog
// ─────────────────────────────────────────────────────────────────────────────

function PolicyCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!key.trim() || !title.trim()) return;
    setBusy(true);
    try {
      await apiPost(`/api/admin/policies`, {
        key: key.trim().toUpperCase().replace(/\s+/g, "_"),
        title: title.trim(),
        description: description.trim() || null,
        targetWorkerTypes: ["EMPLOYEE", "CONTRACTOR", "TRAINEE"],
        enforcement: "INFO",
        workerAction: "ACKNOWLEDGE",
        resignTrigger: "ONE_TIME",
      });
      publishInlineMessage({ type: "SUCCESS", text: "Policy created. Add a version to publish content." });
      onCreated();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Create failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>New policy</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Key (stable identifier)</Text>
                  <Input
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="SAFETY_SOP"
                    size="sm"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Title</Text>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Safety SOP"
                    size="sm"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Description (optional)</Text>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    size="sm"
                  />
                </Box>
                <Text fontSize="2xs" color="fg.muted">
                  Workers won't see this policy until you add its content and publish it.
                  You can also fine-tune who it applies to, whether signing is required, and
                  when workers need to re-sign — those settings live under <b>Edit metadata</b>{" "}
                  after you create the policy.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button colorPalette="blue" onClick={submit} loading={busy} disabled={!key.trim() || !title.trim()}>
                  Create
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// New-version dialog
// ─────────────────────────────────────────────────────────────────────────────

function NewVersionDialog({
  policyId,
  onClose,
  onCreated,
}: {
  policyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [contentMarkdown, setContentMarkdown] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [forcesResign, setForcesResign] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!changeNote.trim()) return;
    setBusy(true);
    try {
      await apiPost(`/api/admin/policies/${policyId}/versions`, {
        contentFormat: "MARKDOWN",
        contentMarkdown,
        changeNote: changeNote.trim(),
        forcesResign,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Draft version created. Submit for approval when ready." });
      onCreated();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Version create failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="2xl" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>New version</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Change note (why this version?)</Text>
                  <Input
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                    placeholder="Added drug testing consent section"
                    size="sm"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Content (Markdown)</Text>
                  <Textarea
                    value={contentMarkdown}
                    onChange={(e) => setContentMarkdown(e.target.value)}
                    rows={12}
                    size="sm"
                    fontFamily="mono"
                  />
                </Box>
                <HStack>
                  <input
                    id="forcesResign"
                    type="checkbox"
                    checked={forcesResign}
                    onChange={(e) => setForcesResign(e.target.checked)}
                  />
                  <label htmlFor="forcesResign" style={{ fontSize: "12px" }}>
                    Forces re-sign — every worker's current signature becomes invalid at publish time.
                    Uncheck for typo fixes; check for material content changes.
                  </label>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button colorPalette="blue" onClick={submit} loading={busy} disabled={!changeNote.trim()}>
                  Create draft
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload review row (embedded in the pending-reviews section)
// ─────────────────────────────────────────────────────────────────────────────

function UploadReviewRow({ row, onReviewed }: { row: PendingUploadReview; onReviewed: () => void }) {
  const [busy, setBusy] = useState<"APPROVE" | "REJECT" | "DOWNLOAD" | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  async function submitDecision(decision: "APPROVE" | "REJECT", reason?: string) {
    setBusy(decision);
    try {
      await apiPost(`/api/admin/policies/signatures/${row.id}/review`, {
        decision,
        reason: decision === "REJECT" ? reason : undefined,
      });
      publishInlineMessage({ type: "SUCCESS", text: `Upload ${decision.toLowerCase()}d.` });
      onReviewed();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Review failed.", err) });
    } finally {
      setBusy(null);
    }
  }
  function decide(decision: "APPROVE" | "REJECT") {
    if (decision === "REJECT") {
      setRejectOpen(true);
      return;
    }
    void submitDecision("APPROVE");
  }

  async function download() {
    if (!row.uploadR2Key) return;
    setBusy("DOWNLOAD");
    try {
      const { url } = await apiGet<{ url: string }>(
        `/api/me/policies/download?r2Key=${encodeURIComponent(row.uploadR2Key)}`,
      );
      window.open(url, "_blank");
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Download failed.", err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Box
        p={2}
        borderWidth="1px"
        borderColor="orange.200"
        bg="orange.50"
        borderRadius="md"
        fontSize="xs"
      >
        <VStack align="stretch" gap={2}>
          <VStack align="start" gap={0.5}>
            <Text fontWeight="medium">
              {row.user.displayName ?? row.user.email ?? row.user.id}
            </Text>
            <Badge size="xs" colorPalette="gray" variant="outline" alignSelf="flex-start">
              {row.version.policyDocument.title} v{row.version.versionNumber}
            </Badge>
            {row.uploadFileName && (
              <Text color="fg.muted" fontSize="2xs">
                {row.uploadFileName} · signed {new Date(row.signedAt).toLocaleDateString()}
              </Text>
            )}
          </VStack>
          <HStack gap={2} justify="flex-end" wrap="wrap">
            <Button size="xs" variant="outline" onClick={download} loading={busy === "DOWNLOAD"} disabled={!row.uploadR2Key}>
              <Download size={10} />
            </Button>
            <Button size="xs" variant="outline" colorPalette="red" onClick={() => decide("REJECT")} loading={busy === "REJECT"}>
              <XCircle size={10} /> Reject
            </Button>
            <Button size="xs" colorPalette="green" onClick={() => decide("APPROVE")} loading={busy === "APPROVE"}>
              <CheckCircle2 size={10} /> Approve
            </Button>
          </HStack>
        </VStack>
      </Box>
      <ConfirmDialog
        open={rejectOpen}
        title="Reject this upload?"
        message={`Reject ${row.uploadFileName ?? "this artifact"} for ${row.user.displayName ?? row.user.email ?? "this worker"}? The worker will need to upload a corrected file.`}
        confirmLabel="Reject"
        confirmColorPalette="red"
        inputLabel="Rejection reason (shown to the worker)"
        inputPlaceholder="e.g. Certificate expired; upload a current one"
        onCancel={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          setRejectOpen(false);
          await submitDecision("REJECT", reason);
        }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: upload-on-behalf dialog
//
// Bypasses the worker sign wizard by uploading an artifact directly to a
// worker's compliance file. For SIGN-type policies (server enforces) the
// admin must type APPROVE to confirm — protects against accidental
// overrides on policies where the signature matters legally.
// ─────────────────────────────────────────────────────────────────────────────

type UserPickerRow = { id: string; displayName: string | null; email: string | null; workerType: string | null };

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function AdminUploadOnBehalfDialog({
  policy,
  onClose,
  onUploaded,
}: {
  policy: PolicyDetail;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [users, setUsers] = useState<UserPickerRow[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [approveText, setApproveText] = useState<string>("");
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedContentType, setUploadedContentType] = useState<string | null>(null);
  const [uploadedDigest, setUploadedDigest] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await apiGet<UserPickerRow[]>("/api/admin/users?role=WORKER&approved=true");
        setUsers(rows);
      } catch {
        setUsers([]);
      }
    })();
  }, []);

  async function handleFilePicked(file: File) {
    if (selectedUserIds.length === 0) return;
    setUploading(true);
    try {
      const bytes = await file.arrayBuffer();
      const digest = await sha256Hex(bytes);
      // Presign against the FIRST selected worker as the R2 key owner.
      // The bytes are uploaded once; the resulting key is then used as the
      // uploadR2Key on every per-worker signature we create. This means
      // multiple workers can share the same underlying artifact — cheap
      // storage, cheap admin motion.
      const presign = await apiPost<{ uploadUrl: string; key: string }>(
        `/api/admin/policies/upload-on-behalf/upload-url`,
        {
          userId: selectedUserIds[0],
          policyId: policy.id,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
        },
      );
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        body: bytes,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      setUploadedKey(presign.key);
      setUploadedFileName(file.name);
      setUploadedContentType(file.type || "application/octet-stream");
      setUploadedDigest(digest);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    } finally {
      setUploading(false);
    }
  }

  const requireApproveType = policy.workerAction === "SIGN";
  const canSubmit =
    selectedUserIds.length > 0 &&
    !!uploadedKey &&
    !!uploadedDigest &&
    (!policy.workerUploadRequiresExpiry || !!expiresAt) &&
    (!requireApproveType || approveText === "APPROVE");

  async function submit() {
    if (!canSubmit || !uploadedKey || !uploadedDigest) return;
    setBusy(true);
    try {
      // Create one signature per selected worker, all pointing at the
      // shared R2 key uploaded above. Loop client-side; collect failures.
      const failures: string[] = [];
      for (const userId of selectedUserIds) {
        try {
          await apiPost(`/api/admin/policies/upload-on-behalf`, {
            userId,
            policyId: policy.id,
            uploadR2Key: uploadedKey,
            uploadFileName: uploadedFileName,
            uploadContentType: uploadedContentType,
            uploadDigest: uploadedDigest,
            uploadExpiresAt: expiresAt || null,
            typeAcknowledgment: requireApproveType ? "APPROVE" : undefined,
          });
        } catch (err) {
          const name = users.find((u) => u.id === userId)?.displayName ?? userId;
          failures.push(`${name}: ${getErrorMessage("", err).trim()}`);
        }
      }
      const successCount = selectedUserIds.length - failures.length;
      if (failures.length === 0) {
        publishInlineMessage({
          type: "SUCCESS",
          text:
            successCount === 1
              ? "Uploaded on behalf."
              : `Uploaded on behalf of ${successCount} workers.`,
        });
        window.dispatchEvent(new CustomEvent("policies:changed"));
        onUploaded();
      } else if (successCount === 0) {
        publishInlineMessage({ type: "ERROR", text: `Upload-on-behalf failed. ${failures.join(" · ")}` });
      } else {
        publishInlineMessage({
          type: "WARNING",
          text: `${successCount} succeeded, ${failures.length} failed: ${failures.join(" · ")}`,
        });
        window.dispatchEvent(new CustomEvent("policies:changed"));
        onUploaded();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>Upload on behalf — {policy.title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>
                    Workers {selectedUserIds.length > 0 && `(${selectedUserIds.length} selected)`}
                  </Text>
                  <WorkerPicker
                    workers={users}
                    selectedIds={selectedUserIds}
                    onChange={setSelectedUserIds}
                    placeholder="Search workers…"
                  />
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Pick one or more. The same file will be attached to every selected worker's signature.
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>
                    Upload {policy.workerUploadLabel ?? "artifact"}
                  </Text>
                  <Input
                    type="file"
                    accept={policy.workerUploadAcceptedTypes ?? "application/pdf,image/*"}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f && selectedUserIds.length > 0) void handleFilePicked(f);
                    }}
                    disabled={uploading || selectedUserIds.length === 0}
                    size="sm"
                  />
                  {uploading && (
                    <HStack gap={2} mt={2}>
                      <Spinner size="xs" /> <Text fontSize="xs">Uploading…</Text>
                    </HStack>
                  )}
                  {uploadedFileName && !uploading && (
                    <Text fontSize="xs" color="green.700" mt={1}>
                      ✓ {uploadedFileName}
                    </Text>
                  )}
                </Box>
                {policy.workerUploadRequiresExpiry && (
                  <Box>
                    <Text fontSize="xs" color="fg.muted" mb={1}>Expiration date</Text>
                    <Input
                      type="date"
                      size="sm"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                    />
                  </Box>
                )}
                {requireApproveType && (
                  <Box>
                    <Text fontSize="xs" color="red.700" mb={1}>
                      This is a SIGN-type policy. Uploading on behalf bypasses the worker signature.
                      Type <b>APPROVE</b> to confirm.
                    </Text>
                    <Input
                      size="sm"
                      value={approveText}
                      onChange={(e) => setApproveText(e.target.value)}
                      placeholder="APPROVE"
                    />
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  onClick={submit}
                  loading={busy}
                  disabled={!canSubmit}
                >
                  Upload{selectedUserIds.length > 1 ? ` (${selectedUserIds.length})` : ""}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant-exception dialog
// ─────────────────────────────────────────────────────────────────────────────

function GrantExceptionDialog({
  policyId,
  policyTitle,
  onClose,
  onGranted,
}: {
  policyId: string;
  policyTitle: string;
  onClose: () => void;
  onGranted: () => void;
}) {
  const [users, setUsers] = useState<UserPickerRow[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await apiGet<UserPickerRow[]>("/api/admin/users?role=WORKER&approved=true");
        setUsers(rows);
      } catch {
        setUsers([]);
      }
    })();
  }, []);

  async function submit() {
    if (selectedUserIds.length === 0 || !expiresAt || !reason.trim()) return;
    setBusy(true);
    try {
      // Grant one exception per selected worker. Same reason + expiry
      // applies to all. Loop client-side because the API takes a single
      // userId per call — batching on the server would need a new endpoint
      // and isn't necessary at typical picker sizes (a few workers).
      // Collect failures so we can surface partial success.
      const failures: string[] = [];
      for (const userId of selectedUserIds) {
        try {
          await apiPost(`/api/admin/policies/${policyId}/exceptions`, {
            userId,
            expiresAt,
            reason: reason.trim(),
          });
        } catch (err) {
          const name = users.find((u) => u.id === userId)?.displayName ?? userId;
          failures.push(`${name}: ${getErrorMessage("", err).trim()}`);
        }
      }
      const successCount = selectedUserIds.length - failures.length;
      if (failures.length === 0) {
        publishInlineMessage({
          type: "SUCCESS",
          text:
            successCount === 1
              ? "Exception granted."
              : `Exception granted to ${successCount} workers.`,
        });
        window.dispatchEvent(new CustomEvent("policies:changed"));
        onGranted();
      } else if (successCount === 0) {
        publishInlineMessage({ type: "ERROR", text: `Grant failed. ${failures.join(" · ")}` });
      } else {
        publishInlineMessage({
          type: "WARNING",
          text: `${successCount} granted, ${failures.length} failed: ${failures.join(" · ")}`,
        });
        window.dispatchEvent(new CustomEvent("policies:changed"));
        onGranted();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>Grant exception — {policyTitle}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="xs" color="fg.muted">
                  While the exception is active, the worker is treated as compliant on this policy
                  regardless of their signature state. Max 90 days.
                </Text>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>
                    Workers {selectedUserIds.length > 0 && `(${selectedUserIds.length} selected)`}
                  </Text>
                  <WorkerPicker
                    workers={users}
                    selectedIds={selectedUserIds}
                    onChange={setSelectedUserIds}
                    placeholder="Search workers…"
                  />
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Pick one or more. Every selected worker gets the same exception (same reason + expiry).
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Expires</Text>
                  <Input
                    type="date"
                    size="sm"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Reason</Text>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    size="sm"
                  />
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  onClick={submit}
                  loading={busy}
                  disabled={selectedUserIds.length === 0 || !expiresAt || !reason.trim()}
                >
                  Grant{selectedUserIds.length > 1 ? ` (${selectedUserIds.length})` : ""}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit-policy-metadata dialog
//
// Lets admin change enforcement, worker action, target types, gates, resign
// trigger, upload flags, and notification channel on an existing policy.
// The service (updatePolicy) only writes fields present in the patch, so we
// diff against the loaded policy and send only the changed keys.
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_TYPES = ["EMPLOYEE", "CONTRACTOR", "TRAINEE"] as const;

function EditPolicyMetadataDialog({
  policy,
  onClose,
  onSaved,
}: {
  policy: PolicyDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(policy.title);
  const [description, setDescription] = useState(policy.description ?? "");
  const [enforcement, setEnforcement] = useState(policy.enforcement);
  const [workerAction, setWorkerAction] = useState(policy.workerAction);
  const [targetWorkerTypes, setTargetWorkerTypes] = useState<string[]>(policy.targetWorkerTypes);
  const [adminCanUploadOnBehalf, setAdminCanUploadOnBehalf] = useState(policy.adminCanUploadOnBehalf);
  const [requiresWorkerUpload, setRequiresWorkerUpload] = useState(policy.requiresWorkerUpload);
  const [workerUploadLabel, setWorkerUploadLabel] = useState(policy.workerUploadLabel ?? "");
  const [workerUploadAcceptedTypes, setWorkerUploadAcceptedTypes] = useState(
    policy.workerUploadAcceptedTypes ?? "",
  );
  const [workerUploadRequiresExpiry, setWorkerUploadRequiresExpiry] = useState(
    policy.workerUploadRequiresExpiry,
  );
  const [workerUploadRequiresApproval, setWorkerUploadRequiresApproval] = useState(
    policy.workerUploadRequiresApproval,
  );
  // Normalize legacy ANNIVERSARY rows to ANNUAL_ON_DATE at load time — new
  // UI never surfaces ANNIVERSARY, and the predicate treats both the same.
  const [resignTrigger, setResignTrigger] = useState(
    policy.resignTrigger === "ANNIVERSARY" ? "ANNUAL_ON_DATE" : policy.resignTrigger,
  );
  const [resignParamDays, setResignParamDays] = useState(
    policy.resignParamDays !== null ? String(policy.resignParamDays) : "",
  );
  const [resignParamMonthDay, setResignParamMonthDay] = useState(
    policy.resignParamMonthDay ?? "",
  );
  const [gatesServices, setGatesServices] = useState<string[]>(policy.gatesServices ?? []);
  function toggleGateService(action: string) {
    setGatesServices((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action],
    );
  }
  const [gatesJobsAbovePrice, setGatesJobsAbovePrice] = useState(
    policy.gatesJobsAbovePrice !== null ? String(policy.gatesJobsAbovePrice) : "",
  );
  const [notifyOnPublish, setNotifyOnPublish] = useState(policy.notifyOnPublish);
  const [graceHoursOverride, setGraceHoursOverride] = useState(
    policy.graceHoursOverride !== null ? String(policy.graceHoursOverride) : "",
  );
  const [busy, setBusy] = useState(false);

  function toggleWorkerType(type: string) {
    setTargetWorkerTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  async function submit() {
    if (graceHoursOverride.trim() !== "") {
      const n = Number(graceHoursOverride);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        publishInlineMessage({
          type: "ERROR",
          text: "Grace hours must be a non-negative whole number, or blank to use the system default.",
        });
        return;
      }
    }
    if (resignTrigger === "DAYS_SINCE_SIGN") {
      const n = Number(resignParamDays);
      if (!resignParamDays.trim() || !Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        publishInlineMessage({
          type: "ERROR",
          text: "Enter a positive whole number of days.",
        });
        return;
      }
    }
    if (resignTrigger === "ANNUAL_ON_DATE") {
      if (!resignParamMonthDay) {
        publishInlineMessage({
          type: "ERROR",
          text: "Pick the recurring date for the Yearly trigger.",
        });
        return;
      }
      const err = validateMonthDay(resignParamMonthDay);
      if (err) {
        publishInlineMessage({ type: "ERROR", text: err });
        return;
      }
    }
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (title.trim() !== policy.title) patch.title = title.trim();
      if ((description.trim() || null) !== policy.description) {
        patch.description = description.trim() || null;
      }
      if (enforcement !== policy.enforcement) patch.enforcement = enforcement;
      if (workerAction !== policy.workerAction) patch.workerAction = workerAction;
      const sortedNext = [...targetWorkerTypes].sort();
      const sortedPrev = [...policy.targetWorkerTypes].sort();
      if (JSON.stringify(sortedNext) !== JSON.stringify(sortedPrev)) {
        patch.targetWorkerTypes = targetWorkerTypes;
      }
      if (adminCanUploadOnBehalf !== policy.adminCanUploadOnBehalf) {
        patch.adminCanUploadOnBehalf = adminCanUploadOnBehalf;
      }
      if (requiresWorkerUpload !== policy.requiresWorkerUpload) {
        patch.requiresWorkerUpload = requiresWorkerUpload;
      }
      if ((workerUploadLabel.trim() || null) !== policy.workerUploadLabel) {
        patch.workerUploadLabel = workerUploadLabel.trim() || null;
      }
      if ((workerUploadAcceptedTypes.trim() || null) !== policy.workerUploadAcceptedTypes) {
        patch.workerUploadAcceptedTypes = workerUploadAcceptedTypes.trim() || null;
      }
      if (workerUploadRequiresExpiry !== policy.workerUploadRequiresExpiry) {
        patch.workerUploadRequiresExpiry = workerUploadRequiresExpiry;
      }
      if (workerUploadRequiresApproval !== policy.workerUploadRequiresApproval) {
        patch.workerUploadRequiresApproval = workerUploadRequiresApproval;
      }
      if (resignTrigger !== policy.resignTrigger) patch.resignTrigger = resignTrigger;
      // Only DAYS_SINCE_SIGN reads resignParamDays. ANNIVERSARY is fixed at
      // 365; ONE_TIME and ANNUAL_ON_DATE ignore it. Null it out on those
      // triggers so a stale local value never lands in the DB.
      const nextDays =
        resignTrigger === "DAYS_SINCE_SIGN" && resignParamDays.trim()
          ? Number(resignParamDays.trim())
          : null;
      if (nextDays !== policy.resignParamDays) patch.resignParamDays = nextDays;
      // Same guard for the MM-DD field — only ANNUAL_ON_DATE uses it.
      const nextMonthDay =
        resignTrigger === "ANNUAL_ON_DATE" && resignParamMonthDay.trim()
          ? resignParamMonthDay.trim()
          : null;
      if (nextMonthDay !== policy.resignParamMonthDay) patch.resignParamMonthDay = nextMonthDay;
      const currentGatesServices = policy.gatesServices ?? [];
      if (JSON.stringify([...gatesServices].sort()) !== JSON.stringify([...currentGatesServices].sort())) {
        patch.gatesServices = gatesServices;
      }
      const nextPrice = gatesJobsAbovePrice.trim() ? Number(gatesJobsAbovePrice.trim()) : null;
      if (nextPrice !== policy.gatesJobsAbovePrice) patch.gatesJobsAbovePrice = nextPrice;
      if (notifyOnPublish !== policy.notifyOnPublish) patch.notifyOnPublish = notifyOnPublish;
      const nextGraceOverride = graceHoursOverride.trim() === "" ? null : Number(graceHoursOverride.trim());
      if (nextGraceOverride !== policy.graceHoursOverride) patch.graceHoursOverride = nextGraceOverride;

      if (Object.keys(patch).length === 0) {
        publishInlineMessage({ type: "INFO", text: "No changes to save." });
        setBusy(false);
        return;
      }

      await apiPatch(`/api/admin/policies/${policy.id}`, patch);
      publishInlineMessage({ type: "SUCCESS", text: "Policy updated." });
      onSaved();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="2xl" w="full" rounded="2xl" p={4} maxH="90vh" overflow="hidden">
            <Dialog.Header>
              <Dialog.Title>Edit policy — {policy.title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body overflow="auto">
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Title</Text>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} size="sm" />
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Description</Text>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    size="sm"
                  />
                </Box>

                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>How it's enforced</Text>
                  <HStack gap={1} wrap="wrap">
                    {(["BLOCK", "WARN", "INFO"] as const).map((v) => (
                      <Button
                        key={v}
                        size="xs"
                        variant={enforcement === v ? "solid" : "outline"}
                        colorPalette={enforcement === v ? "blue" : "gray"}
                        onClick={() => setEnforcement(v)}
                      >
                        {ENFORCEMENT_LABEL[v]}
                      </Button>
                    ))}
                  </HStack>
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    {ENFORCEMENT_HELP[enforcement]}
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>What the worker does</Text>
                  <HStack gap={1} wrap="wrap">
                    {(["SIGN", "ACKNOWLEDGE", "NONE"] as const).map((v) => (
                      <Button
                        key={v}
                        size="xs"
                        variant={workerAction === v ? "solid" : "outline"}
                        colorPalette={workerAction === v ? "blue" : "gray"}
                        onClick={() => setWorkerAction(v)}
                      >
                        {WORKER_ACTION_LABEL[v]}
                      </Button>
                    ))}
                  </HStack>
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    {WORKER_ACTION_HELP[workerAction]}
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Which worker types this applies to</Text>
                  <HStack gap={1} wrap="wrap">
                    {WORKER_TYPES.map((t) => (
                      <Button
                        key={t}
                        size="xs"
                        variant={targetWorkerTypes.includes(t) ? "solid" : "outline"}
                        colorPalette={targetWorkerTypes.includes(t) ? "green" : "gray"}
                        onClick={() => toggleWorkerType(t)}
                      >
                        {WORKER_TYPE_LABEL[t]}
                      </Button>
                    ))}
                  </HStack>
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Admins and supers only see this if they also have a worker type set on the Users tab. Clients never see any compliance content.
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>How often to re-sign</Text>
                  <HStack gap={1} wrap="wrap">
                    {(["ONE_TIME", "DAYS_SINCE_SIGN", "ANNUAL_ON_DATE"] as const).map((v) => (
                      <Button
                        key={v}
                        size="xs"
                        variant={resignTrigger === v ? "solid" : "outline"}
                        colorPalette={resignTrigger === v ? "blue" : "gray"}
                        onClick={() => {
                          setResignTrigger(v);
                          // Sensible defaults so the operator isn't staring
                          // at a blank required field the moment they pick
                          // a trigger that needs a parameter.
                          if (v === "DAYS_SINCE_SIGN" && !resignParamDays.trim()) {
                            setResignParamDays("90");
                          }
                        }}
                      >
                        {RESIGN_TRIGGER_LABEL[v] ?? v}
                      </Button>
                    ))}
                  </HStack>
                  {resignTrigger === "DAYS_SINCE_SIGN" && (
                    <Box mt={2}>
                      <Text fontSize="2xs" color="fg.muted" mb={1}>
                        Days between re-signs <Text as="span" color="red.700">*</Text>
                      </Text>
                      <Input
                        type="number"
                        size="sm"
                        min={1}
                        value={resignParamDays}
                        onChange={(e) => setResignParamDays(e.target.value)}
                        placeholder="90"
                        borderColor={
                          !resignParamDays.trim() || !(Number(resignParamDays) > 0)
                            ? "red.400"
                            : undefined
                        }
                      />
                    </Box>
                  )}
                  {resignTrigger === "ANNUAL_ON_DATE" && (
                    <Box mt={2}>
                      <Text fontSize="2xs" color="fg.muted" mb={1}>
                        Which day of the year <Text as="span" color="red.700">*</Text>
                      </Text>
                      <Input
                        type="date"
                        size="sm"
                        value={monthDayToDateInput(resignParamMonthDay)}
                        onChange={(e) => setResignParamMonthDay(dateInputToMonthDay(e.target.value))}
                        borderColor={!resignParamMonthDay ? "red.400" : undefined}
                      />
                      <Text fontSize="2xs" color="fg.muted" mt={1}>
                        Everyone re-signs by this date each year (year is ignored).
                      </Text>
                    </Box>
                  )}
                </Box>

                <Box borderTopWidth="1px" pt={3}>
                  <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2}>
                    File uploads
                  </Text>
                  <VStack align="stretch" gap={2}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={requiresWorkerUpload}
                        onChange={(e) => setRequiresWorkerUpload(e.target.checked)}
                      />
                      Worker must upload a file (e.g. insurance certificate)
                    </label>
                    {requiresWorkerUpload && (
                      <>
                        <Box>
                          <Text fontSize="2xs" color="fg.muted" mb={1}>What to call the file (shown to the worker)</Text>
                          <Input
                            size="sm"
                            value={workerUploadLabel}
                            onChange={(e) => setWorkerUploadLabel(e.target.value)}
                            placeholder="Insurance certificate"
                          />
                        </Box>
                        <Box>
                          <Text fontSize="2xs" color="fg.muted" mb={1}>
                            Allowed file types
                          </Text>
                          <Input
                            size="sm"
                            value={workerUploadAcceptedTypes}
                            onChange={(e) => setWorkerUploadAcceptedTypes(e.target.value)}
                            placeholder="application/pdf,image/*"
                          />
                          <Text fontSize="2xs" color="fg.muted" mt={1}>
                            Comma-separated MIME types. Use <code>application/pdf</code> for PDFs, <code>image/*</code> for photos.
                          </Text>
                        </Box>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={workerUploadRequiresExpiry}
                            onChange={(e) => setWorkerUploadRequiresExpiry(e.target.checked)}
                          />
                          Worker must enter an expiration date
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={workerUploadRequiresApproval}
                            onChange={(e) => setWorkerUploadRequiresApproval(e.target.checked)}
                          />
                          Admin must review before it counts as compliant
                        </label>
                      </>
                    )}
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={adminCanUploadOnBehalf}
                        onChange={(e) => setAdminCanUploadOnBehalf(e.target.checked)}
                      />
                      Admin can also upload for the worker
                    </label>
                  </VStack>
                </Box>

                <Box borderTopWidth="1px" pt={3}>
                  <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2}>
                    What this blocks (when enforcement is Block)
                  </Text>
                  <VStack align="stretch" gap={2}>
                    <Box>
                      <Text fontSize="2xs" color="fg.muted" mb={1}>
                        Which actions this policy blocks
                      </Text>
                      <HStack gap={1} wrap="wrap">
                        {(["WORKDAY_START", "JOB_CLAIM", "RESERVE_EQUIPMENT"] as const).map((a) => (
                          <Button
                            key={a}
                            size="xs"
                            variant={gatesServices.includes(a) ? "solid" : "outline"}
                            colorPalette={gatesServices.includes(a) ? "red" : "gray"}
                            onClick={() => toggleGateService(a)}
                          >
                            {GATE_SERVICE_LABEL[a]}
                          </Button>
                        ))}
                      </HStack>
                      <Text fontSize="2xs" color="fg.muted" mt={1}>
                        Toggle an action to block workers from doing it until they've completed this policy.
                      </Text>
                      {gatesServices.includes("JOB_CLAIM") && (
                        <Box
                          mt={2}
                          pl={3}
                          borderLeftWidth="2px"
                          borderLeftColor="gray.300"
                        >
                          <Text fontSize="2xs" color="fg.muted" mb={1}>
                            Only fire the Claim-a-job block on jobs above this price (optional)
                          </Text>
                          <Input
                            type="number"
                            size="sm"
                            value={gatesJobsAbovePrice}
                            onChange={(e) => setGatesJobsAbovePrice(e.target.value)}
                            placeholder="Leave blank to block every job claim"
                          />
                          <Text fontSize="2xs" color="fg.muted" mt={1}>
                            Blank = every job claim is blocked. Set a dollar amount = jobs below it wave through, jobs at or above it get blocked.
                          </Text>
                        </Box>
                      )}
                    </Box>
                    <Box>
                      <Text fontSize="2xs" color="fg.muted" mb={1}>
                        Grace window after a new version publishes (hours)
                      </Text>
                      <Input
                        type="number"
                        size="sm"
                        min={0}
                        value={graceHoursOverride}
                        onChange={(e) => setGraceHoursOverride(e.target.value)}
                        placeholder="Leave blank to use the system default"
                      />
                      <Text fontSize="2xs" color="fg.muted" mt={1}>
                        Leave blank to inherit the system default. Enter <b>0</b> for no grace — the block kicks in the instant the version publishes.
                        Use zero for federally-mandated documents where any uncovered window is unacceptable.
                      </Text>
                    </Box>
                  </VStack>
                </Box>

                <Box borderTopWidth="1px" pt={3}>
                  <Text fontSize="xs" color="fg.muted" mb={1}>Notify workers when a new version is published</Text>
                  <HStack gap={1} wrap="wrap">
                    {["PUSH_ONLY", "ALL_CHANNELS"].map((v) => (
                      <Button
                        key={v}
                        size="xs"
                        variant={notifyOnPublish === v ? "solid" : "outline"}
                        colorPalette={notifyOnPublish === v ? "blue" : "gray"}
                        onClick={() => setNotifyOnPublish(v)}
                      >
                        {NOTIFY_LABEL[v] ?? v}
                      </Button>
                    ))}
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  onClick={submit}
                  loading={busy}
                  disabled={
                    (resignTrigger === "ANNUAL_ON_DATE" &&
                      (!resignParamMonthDay || !!validateMonthDay(resignParamMonthDay))) ||
                    (resignTrigger === "DAYS_SINCE_SIGN" &&
                      (!resignParamDays.trim() ||
                        !(Number(resignParamDays) > 0) ||
                        !Number.isInteger(Number(resignParamDays))))
                  }
                >
                  Save
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sign matrix view
//
// Worker × policy grid. Each cell shows the compliance status. Supports CSV
// download so the admin can hand it to a CPA or use it for an offline audit.
// ─────────────────────────────────────────────────────────────────────────────

type MatrixCellStatus = "CURRENT" | "PENDING" | "EXCEPTION" | "NOT_TARGETED";

type SignMatrixData = {
  users: Array<{
    id: string;
    displayName: string | null;
    email: string | null;
    workerType: string | null;
  }>;
  policies: Array<{
    id: string;
    key: string;
    title: string;
    enforcement: string;
    workerAction: string;
    targetWorkerTypes: string[];
  }>;
  cells: Array<{
    userId: string;
    policyId: string;
    status: MatrixCellStatus;
    signedAt: string | null;
    expiresAt: string | null;
  }>;
};

function SignMatrixView() {
  const [data, setData] = useState<SignMatrixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiGet<SignMatrixData>("/api/admin/policies/sign-matrix");
      setData(d);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load matrix.", err) });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredUsers = useMemo(() => {
    if (!data) return [];
    if (filterType === "ALL") return data.users;
    return data.users.filter((u) => u.workerType === filterType);
  }, [data, filterType]);

  const cellIndex = useMemo(() => {
    const idx = new Map<string, SignMatrixData["cells"][number]>();
    if (data) {
      for (const c of data.cells) {
        idx.set(`${c.userId}::${c.policyId}`, c);
      }
    }
    return idx;
  }, [data]);

  function downloadCsv() {
    if (!data) return;
    const rows: string[] = [];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = [
      "Worker",
      "Email",
      "Worker type",
      ...data.policies.map((p) => p.title),
    ];
    rows.push(header.map(escape).join(","));
    for (const u of filteredUsers) {
      const cells = data.policies.map((p) => {
        const cell = cellIndex.get(`${u.id}::${p.id}`);
        if (!cell) return "";
        if (cell.status === "NOT_TARGETED") return "N/A";
        if (cell.status === "EXCEPTION") {
          return cell.expiresAt
            ? `Exception (until ${bizDateKey(cell.expiresAt)})`
            : "Exception";
        }
        if (cell.status === "CURRENT") {
          return cell.signedAt
            ? `Signed ${bizDateKey(cell.signedAt)}`
            : "Signed";
        }
        return "Pending";
      });
      rows.push(
        [u.displayName ?? "", u.email ?? "", u.workerType ?? "", ...cells]
          .map(escape)
          .join(","),
      );
    }
    // Prepend a UTF-8 BOM so Excel + Numbers open the file as UTF-8 by
    // default. Without it, both apps guess the encoding and mangle any
    // non-ASCII character (em-dash showed up as "â" before this).
    const csv = "﻿" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compliance-sign-matrix-${bizToday()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function cellDisplay(status: MatrixCellStatus, signedAt: string | null, expiresAt: string | null) {
    if (status === "NOT_TARGETED") {
      return <Text color="fg.muted" fontSize="xs">—</Text>;
    }
    if (status === "EXCEPTION") {
      return (
        <VStack gap={0.5} align="center">
          <Badge size="xs" colorPalette="yellow" variant="solid">
            Exception
          </Badge>
          {expiresAt && (
            <Text fontSize="2xs" color="fg.muted">
              until {fmtDate(expiresAt)}
            </Text>
          )}
        </VStack>
      );
    }
    if (status === "CURRENT") {
      return (
        <VStack gap={0.5} align="center">
          <Badge size="xs" colorPalette="green" variant="subtle">
            <CheckCircle2 size={10} /> Signed
          </Badge>
          {signedAt && (
            <Text fontSize="2xs" color="fg.muted">
              {fmtDate(signedAt)}
            </Text>
          )}
        </VStack>
      );
    }
    return (
      <Badge size="xs" colorPalette="red" variant="solid">
        Pending
      </Badge>
    );
  }

  if (loading && !data) {
    return (
      <Box textAlign="center" py={8}>
        <Spinner />
      </Box>
    );
  }
  if (!data || data.users.length === 0 || data.policies.length === 0) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="fg.muted" fontSize="sm">
          No workers or policies yet.
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <HStack mb={3} gap={2} wrap="wrap">
        <Text fontSize="xs" color="fg.muted">Filter:</Text>
        {(["ALL", "EMPLOYEE", "CONTRACTOR", "TRAINEE"] as const).map((t) => (
          <Button
            key={t}
            size="xs"
            variant={filterType === t ? "solid" : "outline"}
            colorPalette={filterType === t ? "blue" : "gray"}
            onClick={() => setFilterType(t)}
          >
            {t === "ALL" ? "All" : WORKER_TYPE_LABEL[t]}
          </Button>
        ))}
        <Box flex="1" />
        <Button size="xs" variant="outline" onClick={downloadCsv}>
          <Download size={12} /> Download CSV
        </Button>
      </HStack>

      <Box overflowX="auto" borderWidth="1px" borderRadius="md">
        <Box as="table" w="full" style={{ borderCollapse: "collapse" }}>
          <Box as="thead" bg="gray.50">
            <Box as="tr">
              <Box
                as="th"
                p={2}
                textAlign="left"
                fontSize="xs"
                fontWeight="semibold"
                borderBottomWidth="1px"
                position="sticky"
                left={0}
                bg="gray.50"
                zIndex={1}
                minW="180px"
              >
                Worker
              </Box>
              {data.policies.map((p) => (
                <Box
                  as="th"
                  key={p.id}
                  p={2}
                  fontSize="2xs"
                  fontWeight="semibold"
                  borderBottomWidth="1px"
                  borderLeftWidth="1px"
                  textAlign="center"
                  minW="120px"
                >
                  <VStack gap={0.5} align="center">
                    <Text fontSize="2xs" fontWeight="semibold" lineClamp={2}>
                      {p.title}
                    </Text>
                    <HStack gap={1} wrap="wrap" justify="center">
                      <Badge
                        size="xs"
                        colorPalette={
                          p.enforcement === "BLOCK" ? "red" : p.enforcement === "WARN" ? "orange" : "blue"
                        }
                        variant="subtle"
                      >
                        {ENFORCEMENT_LABEL[p.enforcement as "BLOCK" | "WARN" | "INFO"] ?? p.enforcement}
                      </Badge>
                      <Badge size="xs" colorPalette="gray" variant="outline">
                        {WORKER_ACTION_LABEL[p.workerAction as "SIGN" | "ACKNOWLEDGE" | "NONE"] ?? p.workerAction}
                      </Badge>
                    </HStack>
                  </VStack>
                </Box>
              ))}
            </Box>
          </Box>
          <Box as="tbody">
            {filteredUsers.map((u) => (
              <Box as="tr" key={u.id} _hover={{ bg: "gray.50" }}>
                <Box
                  as="td"
                  p={2}
                  borderBottomWidth="1px"
                  fontSize="xs"
                  position="sticky"
                  left={0}
                  bg="white"
                  zIndex={1}
                >
                  <HStack gap={2} align="center">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontSize="xs" fontWeight="medium" lineClamp={1}>
                        {u.displayName ?? u.email ?? u.id}
                      </Text>
                      <Text fontSize="2xs" color="fg.muted">
                        {u.workerType ?? "—"}
                      </Text>
                    </VStack>
                    <NudgeUserButton
                      userId={u.id}
                      hasPending={data.cells.some(
                        (c) => c.userId === u.id && c.status === "PENDING",
                      )}
                    />
                  </HStack>
                </Box>
                {data.policies.map((p) => {
                  const cell = cellIndex.get(`${u.id}::${p.id}`);
                  return (
                    <Box
                      as="td"
                      key={p.id}
                      p={2}
                      borderBottomWidth="1px"
                      borderLeftWidth="1px"
                      textAlign="center"
                    >
                      {cell
                        ? cellDisplay(cell.status, cell.signedAt, cell.expiresAt)
                        : null}
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      <Text fontSize="2xs" color="fg.muted" mt={2}>
        Signed cells show the sign date; exception cells show the expiration date. CSV includes the same values.
      </Text>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Version preview dialog
//
// Renders a version's content in a read-only preview so admins can eyeball
// typos and formatting before publishing. Does NOT record a signature — this
// is not the worker sign wizard.
// ─────────────────────────────────────────────────────────────────────────────

function VersionPreviewDialog({
  policy,
  version,
  onClose,
}: {
  policy: PolicyDetail;
  version: VersionRow;
  onClose: () => void;
}) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    if (version.contentFormat !== "PDF") return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    apiGet<{ url: string | null }>(`/api/admin/policies/versions/${version.id}/content-url`)
      .then((r) => {
        if (cancelled) return;
        if (!r.url) setPdfError("This PDF version has no uploaded content.");
        else setPdfUrl(r.url);
      })
      .catch((err) => {
        if (cancelled) return;
        setPdfError(getErrorMessage("Could not load PDF.", err));
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [version.id, version.contentFormat]);

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="3xl" w="full" rounded="2xl" p={4} maxH="90vh" overflow="hidden">
            <Dialog.Header>
              <VStack align="start" gap={0}>
                <HStack gap={2}>
                  <Dialog.Title>{policy.title}</Dialog.Title>
                  <Badge size="xs" colorPalette="gray" variant="outline">
                    v{version.versionNumber}
                  </Badge>
                  <Badge size="xs" colorPalette="blue" variant="subtle">
                    {VERSION_STATUS_LABEL[version.status] ?? version.status}
                  </Badge>
                </HStack>
                <Text fontSize="2xs" color="fg.muted">
                  Preview — no signature will be recorded. What workers see when signing.
                </Text>
              </VStack>
            </Dialog.Header>
            <Dialog.Body overflow="auto">
              {version.contentFormat === "MARKDOWN" ? (
                <PolicyMarkdown>{version.contentMarkdown ?? "*(empty)*"}</PolicyMarkdown>
              ) : pdfLoading ? (
                <HStack gap={2}>
                  <Spinner size="sm" /> <Text fontSize="sm">Loading PDF…</Text>
                </HStack>
              ) : pdfError ? (
                <Text fontSize="sm" color="red.700">{pdfError}</Text>
              ) : pdfUrl ? (
                <VStack align="stretch" gap={2}>
                  <Box borderWidth="1px" borderRadius="md" overflow="hidden">
                    <iframe
                      src={pdfUrl}
                      title={`${policy.title} v${version.versionNumber}`}
                      style={{ width: "100%", height: "60vh", border: 0, display: "block" }}
                    />
                  </Box>
                  <Text fontSize="2xs" color="fg.muted">
                    If your browser can't render this PDF inline,{" "}
                    <a href={pdfUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                      open it in a new tab
                    </a>
                    .
                  </Text>
                </VStack>
              ) : null}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="space-between">
                <Text fontSize="2xs" color="fg.muted">
                  digest {version.contentDigest.slice(0, 12)}…
                </Text>
                <Button variant="ghost" onClick={onClose}>Close</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nudge worker button
// Sends a push notification prompting the worker to open their Compliance
// tab and sign what's outstanding.
// ─────────────────────────────────────────────────────────────────────────────

export function NudgeUserButton({
  userId,
  hasPending,
  size = "xs",
  label,
}: {
  userId: string;
  hasPending: boolean;
  size?: "xs" | "sm";
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await apiPost<{
        pendingCount: number;
        pushAttempted: number;
        pushDelivered: number;
      }>("/api/admin/policies/nudge", { userId });
      if (r.pushAttempted === 0) {
        publishInlineMessage({
          type: "INFO",
          text: `${r.pendingCount} pending — no push subscription on record. Consider emailing.`,
        });
      } else {
        publishInlineMessage({
          type: "SUCCESS",
          text: `Nudged (${r.pendingCount} pending, ${r.pushDelivered}/${r.pushAttempted} devices).`,
        });
      }
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Nudge failed.", err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      size={size}
      variant="ghost"
      colorPalette="blue"
      onClick={run}
      loading={busy}
      disabled={!hasPending}
      title={hasPending ? "Send push reminder" : "Nothing pending"}
    >
      {label ?? "Nudge"}
    </Button>
  );
}


