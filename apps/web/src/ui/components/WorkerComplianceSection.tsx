"use client";

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
import { AlertTriangle, CheckCircle2, Clock, Eye, FileText, XCircle } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";
import PolicySignWizard, { type RequiredPolicy } from "@/src/ui/dialogs/PolicySignWizard";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import SignedPolicyViewDialog from "@/src/ui/dialogs/SignedPolicyViewDialog";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror GET /me/policies response)
// ─────────────────────────────────────────────────────────────────────────────

type HistoryRow = {
  signatureId: string;
  policyId: string;
  policyKey: string | null;
  policyTitle: string;
  versionId: string;
  versionNumber: number;
  // Content fields — power the "View again" action on each row.
  contentFormat: "MARKDOWN" | "PDF" | string;
  contentMarkdown: string | null;
  contentR2Key: string | null;
  contentFileName: string | null;
  contentContentType: string | null;
  signedAt: string;
  signedByUserId: string;
  signedByDisplayName: string | null;
  onBehalfOf: string | null;
  workerActionAtSign: "SIGN" | "ACKNOWLEDGE" | "NONE";
  uploadStatus: "NONE" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  uploadExpiresAt: string | null;
  uploadRejectionReason: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
};

type AwaitingReviewRow = RequiredPolicy & {
  signatureId: string | null;
  uploadFileName: string | null;
  uploadExpiresAt: string | null;
  uploadedAt: string | null;
};

type WorkerPoliciesView = {
  displayName: string | null;
  required: RequiredPolicy[];
  awaitingReview: AwaitingReviewRow[];
  history: HistoryRow[];
  state: {
    current: boolean;
    pendingPolicyIds: string[];
    nextExpiryAt: string | null;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Compliance section — rendered on the worker's Profile tab.
//
// Shows two sub-sections:
//   1. "Required now" — outstanding policies (missing / expired / pending).
//      Big red "Sign now" button opens the wizard.
//   2. "Recorded on file" — everything the worker has already signed, with
//      signed-by / signed-date / upload status.
//
// Skips rendering entirely when the user has no applicable policies AND
// nothing in history (e.g., admins with workerType=null).
// ─────────────────────────────────────────────────────────────────────────────

export default function WorkerComplianceSection() {
  const [data, setData] = useState<WorkerPoliciesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Set when the worker clicks "Replace upload" on an awaiting-review row:
  // opens the wizard against just that one policy so the resubmission is
  // scoped, not a full-queue re-run.
  const [replacePolicy, setReplacePolicy] = useState<AwaitingReviewRow | null>(null);
  // Set when the worker clicks "Sign" on a single required row — opens
  // the wizard scoped to just that one policy so they can pick their
  // signing order instead of being forced through the full batch.
  const [singleSignPolicy, setSingleSignPolicy] = useState<RequiredPolicy | null>(null);
  // Set when the worker clicks "Cancel upload" — opens the confirm dialog.
  const [cancelPolicy, setCancelPolicy] = useState<AwaitingReviewRow | null>(null);
  // Set when the worker clicks "View" on a Recorded-on-file row —
  // opens the read-only viewer for the exact document that was signed.
  const [viewingHistory, setViewingHistory] = useState<HistoryRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<WorkerPoliciesView>("/api/me/policies");
      setData(res);
    } catch {
      setData(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <Card.Root variant="outline">
        <Card.Body py={4} textAlign="center">
          <Spinner size="sm" />
        </Card.Body>
      </Card.Root>
    );
  }
  if (!data) return null;
  const awaitingReview = data.awaitingReview ?? [];
  if (data.required.length === 0 && awaitingReview.length === 0 && data.history.length === 0) return null;

  // `requiredCount` drives the header chip + "Sign now" button, i.e. things
  // the worker can act on right now. Items awaiting admin review are NOT
  // included — the worker's done their part, ball is in the admin's court.
  const requiredCount = data.required.length;
  // Split required items so the header chips can distinguish "must do to
  // work" (BLOCK) from "should do when you can" (WARN/INFO). Individual
  // rows already carry Required/Recommended badges; matching them in the
  // header removes the "why does the number say 5 but only 2 are Required?"
  // confusion.
  const blockingCount = data.required.filter((p) => p.enforcement === "BLOCK").length;
  const recommendedCount = requiredCount - blockingCount;
  const hasBlocking = blockingCount > 0;

  return (
    <>
      <Card.Root
        variant="outline"
        borderColor={hasBlocking ? "red.400" : requiredCount > 0 ? "orange.400" : "gray.200"}
      >
        <Card.Body p={3}>
          <VStack align="stretch" gap={3}>
            <HStack justify="space-between" wrap="wrap" gap={2}>
              <HStack gap={2}>
                <Text fontSize="md" fontWeight="semibold">
                  Compliance
                </Text>
                {data.state.current ? (
                  <Badge size="sm" colorPalette="green" variant="subtle">
                    <CheckCircle2 size={12} style={{ marginRight: 4 }} /> Up to date
                  </Badge>
                ) : (
                  <HStack gap={1}>
                    {blockingCount > 0 && (
                      <Badge size="sm" colorPalette="red" variant="solid">
                        {blockingCount} required
                      </Badge>
                    )}
                    {recommendedCount > 0 && (
                      <Badge size="sm" colorPalette="orange" variant="subtle">
                        {recommendedCount} recommended
                      </Badge>
                    )}
                  </HStack>
                )}
              </HStack>
              {requiredCount > 0 && (
                <Button
                  size="sm"
                  colorPalette={hasBlocking ? "red" : "orange"}
                  onClick={() => setWizardOpen(true)}
                  title="Sign every outstanding policy in one wizard flow"
                >
                  Sign all
                </Button>
              )}
            </HStack>

            {requiredCount > 0 && (
              <Box>
                <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                  REQUIRED NOW
                </Text>
                <VStack align="stretch" gap={1}>
                  {data.required.map((p) => (
                    <RequiredRow
                      key={p.policyId}
                      policy={p}
                      onSign={() => setSingleSignPolicy(p)}
                    />
                  ))}
                </VStack>
              </Box>
            )}

            {awaitingReview.length > 0 && (
              <Box>
                <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                  AWAITING REVIEW
                </Text>
                <VStack align="stretch" gap={1}>
                  {awaitingReview.map((p) => (
                    <AwaitingReviewRowView
                      key={p.policyId}
                      row={p}
                      onReplace={() => setReplacePolicy(p)}
                      onCancel={() => setCancelPolicy(p)}
                    />
                  ))}
                </VStack>
              </Box>
            )}

            {(() => {
              // Hide pending-review sigs from RECORDED ON FILE — they're
              // rendered separately in AWAITING REVIEW above. Rejected +
              // revoked stay in history as the paper trail.
              const filteredHistory = data.history.filter(
                (h) => h.uploadStatus !== "PENDING_REVIEW",
              );
              if (filteredHistory.length === 0) return null;
              return (
                <Box>
                  <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                    RECORDED ON FILE
                  </Text>
                  <VStack align="stretch" gap={1}>
                    {filteredHistory.slice(0, 10).map((h) => (
                      <HistoryRow
                        key={h.signatureId}
                        row={h}
                        onView={() => setViewingHistory(h)}
                      />
                    ))}
                    {filteredHistory.length > 10 && (
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        +{filteredHistory.length - 10} older entries
                      </Text>
                    )}
                  </VStack>
                </Box>
              );
            })()}
          </VStack>
        </Card.Body>
      </Card.Root>

      {wizardOpen && data.required.length > 0 && (
        <PolicySignWizard
          open={wizardOpen}
          policies={data.required}
          displayName={data.displayName}
          onClose={() => setWizardOpen(false)}
          onCompleted={() => {
            void load();
            // Belt-and-suspenders: the wizard already dispatches
            // policies:signed after each individual sign, but if any of
            // those dispatches were missed (e.g., the last policy fired
            // before the app-root listener remounted), one final
            // dispatch here guarantees the alerts + tasks-page badges
            // refresh at least once at wizard close.
            window.dispatchEvent(new CustomEvent("policies:signed"));
          }}
        />
      )}
      {replacePolicy && (
        <PolicySignWizard
          open={true}
          policies={[replacePolicy]}
          displayName={data.displayName}
          onClose={() => setReplacePolicy(null)}
          onCompleted={() => {
            setReplacePolicy(null);
            void load();
            window.dispatchEvent(new CustomEvent("policies:signed"));
          }}
        />
      )}
      {singleSignPolicy && (
        <PolicySignWizard
          open={true}
          policies={[singleSignPolicy]}
          displayName={data.displayName}
          onClose={() => setSingleSignPolicy(null)}
          onCompleted={() => {
            setSingleSignPolicy(null);
            void load();
            window.dispatchEvent(new CustomEvent("policies:signed"));
          }}
        />
      )}
      {viewingHistory && (
        <SignedPolicyViewDialog
          open={true}
          onClose={() => setViewingHistory(null)}
          title={viewingHistory.policyTitle}
          versionNumber={viewingHistory.versionNumber}
          signedAt={viewingHistory.signedAt}
          contentFormat={viewingHistory.contentFormat}
          contentMarkdown={viewingHistory.contentMarkdown}
          contentR2Key={viewingHistory.contentR2Key}
          contentFileName={viewingHistory.contentFileName}
          contentContentType={viewingHistory.contentContentType}
        />
      )}
      <ConfirmDialog
        open={!!cancelPolicy}
        title="Cancel this upload?"
        message={
          cancelPolicy
            ? `Cancel your ${cancelPolicy.uploadFileName ?? "uploaded artifact"} for ${cancelPolicy.title}? You'll go back to needing to complete this policy.`
            : ""
        }
        confirmLabel="Cancel upload"
        confirmColorPalette="red"
        cancelLabel="Keep waiting"
        onCancel={() => setCancelPolicy(null)}
        onConfirm={async () => {
          if (!cancelPolicy?.signatureId) {
            setCancelPolicy(null);
            return;
          }
          const sigId = cancelPolicy.signatureId;
          setCancelPolicy(null);
          try {
            await apiPost(`/api/me/policies/signatures/${sigId}/cancel`, {});
            publishInlineMessage({ type: "SUCCESS", text: "Upload cancelled." });
            void load();
            // Cancel bumps the pending-review policy back into REQUIRED,
            // so the worker's "Documents to sign" alert count needs to
            // increase and the super's "Uploads to review" count needs to
            // decrease. Dispatch handles both listeners in one shot.
            window.dispatchEvent(new CustomEvent("policies:signed"));
          } catch (err) {
            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Cancel failed.", err) });
          }
        }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function AwaitingReviewRowView({
  row,
  onReplace,
  onCancel,
}: {
  row: AwaitingReviewRow;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const uploadedLabel = row.uploadedAt ? fmtDate(row.uploadedAt) : null;
  const expiresLabel = row.uploadExpiresAt ? fmtDate(row.uploadExpiresAt) : null;
  return (
    <HStack
      gap={2}
      p={2}
      borderRadius="md"
      borderWidth="1px"
      borderColor="blue.200"
      bg="blue.50"
      align="flex-start"
    >
      <Box color="blue.600" flexShrink={0} mt={0.5}>
        <Clock size={14} />
      </Box>
      <VStack align="start" gap={0} flex="1" minW={0}>
        <Text fontSize="sm" fontWeight="medium">
          {row.title}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          Awaiting admin review
          {row.uploadFileName ? ` · ${row.uploadFileName}` : ""}
          {uploadedLabel ? ` · uploaded ${uploadedLabel}` : ""}
        </Text>
        {expiresLabel && (
          <Text fontSize="xs" color="fg.muted">
            expires {expiresLabel}
          </Text>
        )}
      </VStack>
      <VStack gap={1} flexShrink={0}>
        <Button size="xs" variant="ghost" colorPalette="blue" onClick={onReplace}>
          Replace upload
        </Button>
        <Button size="xs" variant="ghost" colorPalette="red" onClick={onCancel} disabled={!row.signatureId}>
          Cancel upload
        </Button>
      </VStack>
    </HStack>
  );
}

function RequiredRow({
  policy,
  onSign,
}: {
  policy: RequiredPolicy;
  onSign: () => void;
}) {
  return (
    <HStack
      gap={2}
      p={2}
      borderRadius="md"
      borderWidth="1px"
      borderColor={policy.enforcement === "BLOCK" ? "red.200" : "orange.200"}
      bg={policy.enforcement === "BLOCK" ? "red.50" : "orange.50"}
      align="flex-start"
    >
      <Box color={policy.enforcement === "BLOCK" ? "red.600" : "orange.600"} flexShrink={0} mt={0.5}>
        <AlertTriangle size={14} />
      </Box>
      <VStack align="start" gap={0} flex="1" minW={0}>
        <Text fontSize="sm" fontWeight="medium">
          {policy.title}
        </Text>
        {policy.description && (
          <Text fontSize="xs" color="fg.muted" lineClamp={2}>
            {policy.description}
          </Text>
        )}
      </VStack>
      <VStack gap={1} flexShrink={0} align="end">
        <Badge size="xs" colorPalette={policy.enforcement === "BLOCK" ? "red" : "orange"} variant="subtle">
          {policy.enforcement === "BLOCK" ? "Required" : "Recommended"}
        </Badge>
        {/* Per-row Sign lets the worker pick their signing order
            instead of being forced through the batch wizard. Button
            has a fixed minW so its width doesn't track the badge
            above it (Required = 8 chars, Recommended = 11 chars —
            with align="stretch" that made the buttons visibly
            different widths across the two enforcement tiers). */}
        <Button
          size="xs"
          minW="14"
          colorPalette={policy.enforcement === "BLOCK" ? "red" : "orange"}
          onClick={onSign}
        >
          Sign
        </Button>
      </VStack>
    </HStack>
  );
}

function HistoryRow({ row, onView }: { row: HistoryRow; onView: () => void }) {
  // Row is viewable when the version has real content behind it — a
  // markdown body or an R2-backed PDF. Revoked/archived rows with no
  // content still render as a paper trail but don't expose a View.
  const hasContent =
    (row.contentFormat === "MARKDOWN" && !!row.contentMarkdown) ||
    (row.contentFormat === "PDF" && !!row.contentR2Key);
  const iconColor =
    row.revokedAt
      ? "var(--chakra-colors-gray-500)"
      : row.uploadStatus === "REJECTED"
        ? "var(--chakra-colors-red-500)"
        : row.uploadStatus === "PENDING_REVIEW"
          ? "var(--chakra-colors-orange-500)"
          : "var(--chakra-colors-green-500)";
  const iconLabel =
    row.revokedAt
      ? "Revoked"
      : row.uploadStatus === "REJECTED"
        ? "Rejected"
        : row.uploadStatus === "PENDING_REVIEW"
          ? "Pending review"
          : "Signed";

  return (
    <HStack gap={2} p={2} borderRadius="md" borderWidth="1px" borderColor="gray.100">
      <Box flexShrink={0} color={iconColor}>
        {row.revokedAt || row.uploadStatus === "REJECTED" ? (
          <XCircle size={14} />
        ) : row.uploadStatus === "PENDING_REVIEW" ? (
          <FileText size={14} />
        ) : (
          <CheckCircle2 size={14} />
        )}
      </Box>
      <VStack align="start" gap={0} flex="1" minW={0}>
        <HStack gap={2} wrap="wrap">
          <Text fontSize="sm" fontWeight="medium">
            {row.policyTitle}
          </Text>
          <Badge size="xs" colorPalette="gray" variant="outline">
            v{row.versionNumber}
          </Badge>
        </HStack>
        <HStack gap={2} wrap="wrap">
          <Text fontSize="xs" color="fg.muted">
            {iconLabel} · {fmtDate(row.signedAt)}
          </Text>
          {row.workerActionAtSign === "NONE" && (
            <Badge size="xs" colorPalette="blue" variant="subtle">
              admin-uploaded
            </Badge>
          )}
          {row.uploadExpiresAt && (
            <Text fontSize="xs" color="fg.muted">
              expires {fmtDate(row.uploadExpiresAt)}
            </Text>
          )}
        </HStack>
        {row.uploadStatus === "REJECTED" && row.uploadRejectionReason && (
          <Text fontSize="xs" color="red.700">
            {row.uploadRejectionReason}
          </Text>
        )}
        {row.revokedAt && row.revokedReason && (
          <Text fontSize="xs" color="fg.muted">
            {row.revokedReason}
          </Text>
        )}
      </VStack>
      {hasContent && (
        <Button
          size="xs"
          variant="ghost"
          onClick={onView}
          title="View the document you signed"
          flexShrink={0}
        >
          <Eye size={12} />
          <Text ml={1}>View</Text>
        </Button>
      )}
    </HStack>
  );
}
