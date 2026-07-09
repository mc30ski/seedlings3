"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, FileText, Upload } from "lucide-react";
import { apiPost } from "@/src/lib/api";
import { bizToday } from "@/src/lib/lib";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import PolicyMarkdown from "@/src/ui/components/PolicyMarkdown";

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror the shape returned by GET /me/policies)
// ─────────────────────────────────────────────────────────────────────────────

export type RequiredPolicy = {
  policyId: string;
  key: string;
  title: string;
  description: string | null;
  enforcement: "BLOCK" | "WARN" | "INFO";
  workerAction: "SIGN" | "ACKNOWLEDGE" | "NONE";
  requiresWorkerUpload: boolean;
  workerUploadLabel: string | null;
  workerUploadAcceptedTypes: string | null;
  workerUploadRequiresExpiry: boolean;
  currentVersion: {
    id: string;
    versionNumber: number;
    contentFormat: "MARKDOWN" | "PDF";
    contentMarkdown: string | null;
    contentR2Key: string | null;
    contentFileName: string | null;
    contentContentType: string | null;
    pdfPageCount: number | null;
    contentDigest: string;
  } | null;
  sortOrder: number;
};

type Props = {
  open: boolean;
  policies: RequiredPolicy[];
  displayName: string | null;
  onClose: () => void;
  onCompleted: () => void; // called when the worker finishes at least one policy
};

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 digest — used to compute uploadDigest client-side so the server can
// dedupe repeat uploads. Uses Web Crypto (available in all modern browsers).
// ─────────────────────────────────────────────────────────────────────────────

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard
//
// Multi-step flow through every outstanding required policy. Each policy is
// itself a 2-3 step sub-flow:
//   1. Read step — render markdown or PDF placeholder; scroll-to-bottom or
//      per-page dwell before enabling "Continue".
//   2. Upload step (if requiresWorkerUpload) — file picker + optional expiry
//      date input.
//   3. Sign step — typed legal name + acknowledgment checkbox.
//
// After the final sub-step, the wizard advances to the next required
// policy. When all are signed, closes and fires onCompleted.
// ─────────────────────────────────────────────────────────────────────────────

type SubStep = "read" | "upload" | "sign";

export default function PolicySignWizard({ open, policies, displayName, onClose, onCompleted }: Props) {
  const [policyIndex, setPolicyIndex] = useState(0);
  const [subStep, setSubStep] = useState<SubStep>("read");
  const [readComplete, setReadComplete] = useState(false);
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedContentType, setUploadedContentType] = useState<string | null>(null);
  const [uploadedDigest, setUploadedDigest] = useState<string | null>(null);
  const [uploadExpiresAt, setUploadExpiresAt] = useState<string>("");
  const [typedName, setTypedName] = useState<string>("");
  const [acknowledged, setAcknowledged] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);

  const currentPolicy = policies[policyIndex];

  // Reset the sub-flow whenever the current policy changes.
  useEffect(() => {
    setSubStep("read");
    setReadComplete(false);
    setUploadedKey(null);
    setUploadedFileName(null);
    setUploadedContentType(null);
    setUploadedDigest(null);
    setUploadExpiresAt("");
    setTypedName("");
    setAcknowledged(false);
  }, [policyIndex]);

  // Ensure policyIndex stays in bounds when the list shrinks (rare but happens
  // if admin archives a policy mid-wizard).
  useEffect(() => {
    if (policies.length === 0) {
      onCompleted();
      onClose();
    } else if (policyIndex >= policies.length) {
      setPolicyIndex(0);
    }
  }, [policies.length]);

  const totalSteps = policies.length;

  const advance = useCallback(() => {
    if (policyIndex + 1 >= totalSteps) {
      onCompleted();
      onClose();
    } else {
      setPolicyIndex(policyIndex + 1);
    }
  }, [policyIndex, totalSteps, onClose, onCompleted]);

  async function handleFilePicked(file: File) {
    if (!currentPolicy || !currentPolicy.currentVersion) return;
    setUploading(true);
    try {
      const bytes = await file.arrayBuffer();
      const digest = await sha256Hex(bytes);
      const presign = await apiPost<{ uploadUrl: string; key: string }>(
        `/api/me/policies/versions/${currentPolicy.currentVersion.id}/upload-url`,
        { fileName: file.name, contentType: file.type || "application/octet-stream" },
      );
      // Direct PUT to R2. If the network flakes, worker can retry by picking
      // the file again — server will accept whichever attempt lands last.
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        body: bytes,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed with status ${putRes.status}`);
      }
      setUploadedKey(presign.key);
      setUploadedFileName(file.name);
      setUploadedContentType(file.type || "application/octet-stream");
      setUploadedDigest(digest);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Upload failed. Try again.", err),
      });
    } finally {
      setUploading(false);
    }
  }

  async function submitSign() {
    if (!currentPolicy || !currentPolicy.currentVersion) return;
    setBusy(true);
    try {
      if (currentPolicy.workerAction === "ACKNOWLEDGE") {
        await apiPost(`/api/me/policies/versions/${currentPolicy.currentVersion.id}/acknowledge`, {});
      } else {
        await apiPost(`/api/me/policies/versions/${currentPolicy.currentVersion.id}/sign`, {
          typedName,
          uploadR2Key: uploadedKey ?? undefined,
          uploadFileName: uploadedFileName ?? undefined,
          uploadContentType: uploadedContentType ?? undefined,
          uploadDigest: uploadedDigest ?? undefined,
          uploadExpiresAt: uploadExpiresAt || undefined,
        });
      }
      publishInlineMessage({ type: "SUCCESS", text: `${currentPolicy.title} signed.` });
      // Broadcast so the app-root alert/task badges refresh in real time —
      // "Documents to sign" count should tick down as each policy is signed,
      // not just at the end of the wizard. Also signals the "Compliance
      // uploads to review" super badge to refresh when SIGN policies with
      // uploads create a new PENDING_REVIEW row.
      window.dispatchEvent(new CustomEvent("policies:signed"));
      advance();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Sign failed. Try again.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  // For a policy with requiresWorkerUpload=true, submit must have an
  // uploaded artifact. For workerUploadRequiresExpiry, also an expiry.
  const uploadReady = useMemo(() => {
    if (!currentPolicy) return true;
    if (!currentPolicy.requiresWorkerUpload) return true;
    if (!uploadedKey || !uploadedDigest) return false;
    if (currentPolicy.workerUploadRequiresExpiry && !uploadExpiresAt) return false;
    return true;
  }, [currentPolicy, uploadedKey, uploadedDigest, uploadExpiresAt]);

  /**
   * Client-side mirror of the server-side normalizeName helper
   * (apps/api/src/lib/policyPredicate.ts). Keeps the button-enabled logic
   * in lock-step with what the server accepts, so the worker never sees a
   * "typed name doesn't match" error post-submit — the button just stays
   * disabled until it does.
   */
  const normalizeName = (input: string): string =>
    input
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’,]/g, "")
      .replace(/[.\-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const nameMatches = useMemo(() => {
    if (!displayName) return false;
    return normalizeName(typedName) === normalizeName(displayName);
  }, [typedName, displayName]);

  const signReady = useMemo(() => {
    if (!currentPolicy) return false;
    if (currentPolicy.workerAction === "ACKNOWLEDGE") return acknowledged;
    if (!nameMatches || !acknowledged) return false;
    if (!uploadReady) return false;
    return true;
  }, [currentPolicy, nameMatches, acknowledged, uploadReady]);

  if (!currentPolicy) return null;

  const version = currentPolicy.currentVersion;
  const contentIsMarkdown = version?.contentFormat === "MARKDOWN";
  const contentIsPdf = version?.contentFormat === "PDF";

  // Sub-step ordering: read → (upload if required) → sign. If policy doesn't
  // require upload, skip step 2 entirely.
  const orderedSteps: SubStep[] = [
    "read",
    ...(currentPolicy.requiresWorkerUpload ? (["upload"] as const) : []),
    "sign",
  ];
  const currentStepIdx = orderedSteps.indexOf(subStep);
  const stepCount = orderedSteps.length;

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="2xl" w="full" rounded="2xl" p={0} maxH="90vh" display="flex" flexDirection="column">
            <Dialog.Header px={4} py={3} borderBottomWidth="1px">
              <VStack align="start" gap={0.5}>
                <HStack gap={2} wrap="wrap">
                  <Text fontSize="xs" color="fg.muted">
                    Policy {policyIndex + 1} of {totalSteps}
                  </Text>
                  <Badge size="xs" colorPalette={currentPolicy.enforcement === "BLOCK" ? "red" : currentPolicy.enforcement === "WARN" ? "orange" : "blue"} variant="subtle">
                    {currentPolicy.enforcement}
                  </Badge>
                  <Badge size="xs" colorPalette="gray" variant="outline">
                    Step {currentStepIdx + 1} of {stepCount}
                  </Badge>
                </HStack>
                <Dialog.Title fontSize="lg">{currentPolicy.title}</Dialog.Title>
                {version && (
                  <Text fontSize="xs" color="fg.muted">
                    v{version.versionNumber} · digest {version.contentDigest.slice(0, 12)}…
                  </Text>
                )}
              </VStack>
            </Dialog.Header>
            <Dialog.Body overflowY="auto" flex="1" px={4} py={3}>
              {!version ? (
                <HStack gap={2} p={3} bg="red.50" borderRadius="md" borderWidth="1px" borderColor="red.200">
                  <AlertTriangle size={16} />
                  <Text fontSize="sm">This policy has no published version yet. Contact your admin.</Text>
                </HStack>
              ) : subStep === "read" ? (
                <ReadStep
                  version={version}
                  contentIsMarkdown={!!contentIsMarkdown}
                  contentIsPdf={!!contentIsPdf}
                  readComplete={readComplete}
                  onReadComplete={() => setReadComplete(true)}
                />
              ) : subStep === "upload" ? (
                <UploadStep
                  label={currentPolicy.workerUploadLabel ?? "Document"}
                  acceptedTypes={currentPolicy.workerUploadAcceptedTypes ?? "application/pdf,image/*"}
                  requiresExpiry={currentPolicy.workerUploadRequiresExpiry}
                  uploading={uploading}
                  uploadedFileName={uploadedFileName}
                  uploadExpiresAt={uploadExpiresAt}
                  onFilePicked={handleFilePicked}
                  onExpiryChange={setUploadExpiresAt}
                />
              ) : (
                <SignStep
                  displayName={displayName}
                  workerAction={currentPolicy.workerAction}
                  typedName={typedName}
                  acknowledged={acknowledged}
                  nameMatches={nameMatches}
                  onTypedName={setTypedName}
                  onAcknowledged={setAcknowledged}
                />
              )}
            </Dialog.Body>
            <Dialog.Footer px={4} py={3} borderTopWidth="1px">
              <HStack w="full" gap={2} justify="space-between" wrap="wrap">
                <HStack gap={2}>
                  {/* Cancel — closes the wizard without signing. The gated
                      action that triggered this wizard was already rejected
                      server-side, so cancelling just returns the worker to
                      where they were. If they want to try the action again
                      later, the gate will re-fire the wizard. Present on
                      every step so the worker is never trapped. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onClose}
                    disabled={busy || uploading}
                  >
                    Cancel
                  </Button>
                  {currentStepIdx > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSubStep(orderedSteps[currentStepIdx - 1])}
                      disabled={busy || uploading}
                    >
                      <ChevronLeft size={14} /> Back
                    </Button>
                  )}
                </HStack>
                <HStack gap={2}>
                  {subStep === "read" && (
                    <Button
                      size="sm"
                      colorPalette="blue"
                      onClick={() => setSubStep(orderedSteps[currentStepIdx + 1])}
                      disabled={!readComplete}
                    >
                      Continue <ChevronRight size={14} />
                    </Button>
                  )}
                  {subStep === "upload" && (
                    <Button
                      size="sm"
                      colorPalette="blue"
                      onClick={() => setSubStep("sign")}
                      disabled={!uploadReady}
                    >
                      Continue <ChevronRight size={14} />
                    </Button>
                  )}
                  {subStep === "sign" && (
                    <Button
                      size="sm"
                      colorPalette="green"
                      onClick={submitSign}
                      loading={busy}
                      disabled={!signReady}
                    >
                      <CheckCircle2 size={14} />
                      {currentPolicy.workerAction === "ACKNOWLEDGE" ? "Acknowledge" : "Sign"}
                    </Button>
                  )}
                </HStack>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-steps
// ─────────────────────────────────────────────────────────────────────────────

function ReadStep({
  version,
  contentIsMarkdown,
  contentIsPdf,
  readComplete,
  onReadComplete,
}: {
  version: NonNullable<RequiredPolicy["currentVersion"]>;
  contentIsMarkdown: boolean;
  contentIsPdf: boolean;
  readComplete: boolean;
  onReadComplete: () => void;
}) {
  // Scroll-to-bottom detection for markdown content. For PDF content, the
  // paged per-page dwell flow lands in Slice 4 alongside admin PDF uploads.
  // For now PDF versions show a placeholder + "I've read this" button.
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef || !contentIsMarkdown) return;
    const el = containerRef;
    const check = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      // Short content that fits without scrolling — auto-complete.
      const noScroll = el.scrollHeight <= el.clientHeight + 4;
      if (atBottom || noScroll) onReadComplete();
    };
    check();
    el.addEventListener("scroll", check);
    return () => el.removeEventListener("scroll", check);
  }, [containerRef, contentIsMarkdown, onReadComplete]);

  return (
    <VStack align="stretch" gap={2}>
      <HStack gap={2} p={2} bg="blue.50" borderRadius="md" fontSize="xs" color="blue.900">
        <FileText size={14} />
        <Text>
          {contentIsMarkdown
            ? "Scroll to the bottom of the document to enable the Continue button."
            : contentIsPdf
              ? "PDF content viewer is landing soon. For now, review the document, then click 'I've read it' below."
              : "Review the content, then continue."}
        </Text>
      </HStack>
      <Box
        ref={(el: HTMLDivElement | null) => setContainerRef(el)}
        maxH="50vh"
        overflowY="auto"
        borderWidth="1px"
        borderRadius="md"
        p={4}
        bg="white"
        fontSize="sm"
        lineHeight="tall"
      >
        {contentIsMarkdown && version.contentMarkdown ? (
          <PolicyMarkdown>{version.contentMarkdown}</PolicyMarkdown>
        ) : contentIsPdf ? (
          <VStack gap={2} py={6}>
            <FileText size={32} color="var(--chakra-colors-blue-400)" />
            <Text fontSize="sm">{version.contentFileName ?? "PDF policy content"}</Text>
            <Text fontSize="xs" color="fg.muted">
              {version.pdfPageCount ?? "?"} page{version.pdfPageCount === 1 ? "" : "s"}
            </Text>
            <Button size="sm" variant="outline" onClick={onReadComplete}>
              I&apos;ve read it
            </Button>
          </VStack>
        ) : (
          <Text fontSize="sm" color="fg.muted" fontStyle="italic">
            No content available.
          </Text>
        )}
      </Box>
      {readComplete && (
        <HStack gap={1} fontSize="xs" color="green.700">
          <CheckCircle2 size={12} /> <Text>Read confirmed.</Text>
        </HStack>
      )}
    </VStack>
  );
}

function UploadStep({
  label,
  acceptedTypes,
  requiresExpiry,
  uploading,
  uploadedFileName,
  uploadExpiresAt,
  onFilePicked,
  onExpiryChange,
}: {
  label: string;
  acceptedTypes: string;
  requiresExpiry: boolean;
  uploading: boolean;
  uploadedFileName: string | null;
  uploadExpiresAt: string;
  onFilePicked: (file: File) => void;
  onExpiryChange: (value: string) => void;
}) {
  return (
    <VStack align="stretch" gap={3}>
      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={1}>
          Upload: {label}
        </Text>
        <Text fontSize="xs" color="fg.muted" mb={2}>
          Accepted file types: {acceptedTypes.replace(",", ", ")}. Make sure the whole document is
          visible and text is readable — admin may reject blurry or incomplete photos.
        </Text>
        <Input
          type="file"
          accept={acceptedTypes}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFilePicked(file);
          }}
          disabled={uploading}
          size="sm"
        />
        {uploading && (
          <HStack gap={2} mt={2}>
            <Spinner size="xs" />
            <Text fontSize="xs" color="fg.muted">Uploading…</Text>
          </HStack>
        )}
        {uploadedFileName && !uploading && (
          <HStack gap={1} mt={2} fontSize="xs" color="green.700">
            <CheckCircle2 size={12} /> <Text>{uploadedFileName}</Text>
          </HStack>
        )}
      </Box>
      {requiresExpiry && (
        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Expiration date
          </Text>
          <Text fontSize="xs" color="fg.muted" mb={2}>
            The date shown on the document. Must be in the future.
          </Text>
          <Input
            type="date"
            size="sm"
            value={uploadExpiresAt}
            onChange={(e) => onExpiryChange(e.target.value)}
            min={bizToday()}
          />
        </Box>
      )}
    </VStack>
  );
}

function SignStep({
  displayName,
  workerAction,
  typedName,
  acknowledged,
  nameMatches,
  onTypedName,
  onAcknowledged,
}: {
  displayName: string | null;
  workerAction: "SIGN" | "ACKNOWLEDGE" | "NONE";
  typedName: string;
  acknowledged: boolean;
  nameMatches: boolean;
  onTypedName: (v: string) => void;
  onAcknowledged: (v: boolean) => void;
}) {
  const trimmed = typedName.trim();
  const showMismatchHint = trimmed.length > 0 && !nameMatches;
  return (
    <VStack align="stretch" gap={3}>
      {workerAction === "SIGN" && (
        <Box>
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            Type your legal name
          </Text>
          <Text fontSize="xs" color="fg.muted" mb={2}>
            Please enter your name exactly as: <b>{displayName ?? "(unknown)"}</b>
          </Text>
          <Input
            size="sm"
            value={typedName}
            onChange={(e) => onTypedName(e.target.value)}
            placeholder={displayName ?? "Your legal name"}
            autoComplete="off"
            borderColor={showMismatchHint ? "red.400" : undefined}
          />
          {showMismatchHint && (
            <Text fontSize="xs" color="red.700" mt={1}>
              That doesn't match your account name. Enter{" "}
              <Text as="span" fontWeight="semibold">
                {displayName}
              </Text>{" "}
              to sign.
            </Text>
          )}
          {trimmed.length > 0 && nameMatches && (
            <Text fontSize="xs" color="green.700" mt={1}>
              ✓ Matches your account name.
            </Text>
          )}
        </Box>
      )}
      <Box>
        <Checkbox.Root
          checked={acknowledged}
          onCheckedChange={(e) => onAcknowledged(!!e.checked)}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label fontSize="sm">
            {workerAction === "SIGN"
              ? "I have read the document and agree to its terms."
              : "I have read this document."}
          </Checkbox.Label>
        </Checkbox.Root>
      </Box>
    </VStack>
  );
}
