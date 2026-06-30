"use client";

import { useState } from "react";
import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { Camera, Eye, Paperclip, Trash2, Upload } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import { compressOnly } from "@/src/lib/imageRedact";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  /** BusinessExpense id. The receipt is anchored on the BE so it works for
   *  Step 1 (freestanding), Step 2 (job-Expense pair), or Step 3 (supply
   *  purchase) without changing this component. */
  businessExpenseId: string | null;
  /** Existing receipt metadata, if any. Pass null when no receipt yet. */
  existing?: {
    receiptR2Key?: string | null;
    receiptFileName?: string | null;
    receiptContentType?: string | null;
    receiptUploadedAt?: string | null;
  } | null;
  /** Called after a successful upload or delete with the new state, so the
   *  parent can update its view in place. `null` after a delete. */
  onChanged?: (
    next: {
      receiptR2Key: string | null;
      receiptFileName: string | null;
      receiptContentType: string | null;
      receiptUploadedAt: string | null;
    },
  ) => void;
  /** Compact mode for inline use in dense forms (e.g. Buy More dialog). */
  compact?: boolean;
  /** Override the API base for the receipt endpoints. Defaults to the
   *  admin business-expense routes. Pass e.g. `/api/expenses/<id>` to use
   *  the claimer-accessible job-expense receipt routes. */
  apiBase?: string;
};

export default function ReceiptUpload({
  businessExpenseId,
  existing,
  onChanged,
  compact = false,
  apiBase,
}: Props) {
  const [busy, setBusy] = useState(false);
  const hasReceipt = !!existing?.receiptR2Key;
  // The receipt always lives on a BusinessExpense; `base` is whichever
  // route family can reach it for the current caller.
  const base =
    apiBase ??
    (businessExpenseId ? `/api/admin/business-expenses/${businessExpenseId}` : null);

  async function handleUpload(file: File) {
    if (!base) {
      publishInlineMessage({
        type: "WARNING",
        text: "Save the expense first, then attach a receipt.",
      });
      return;
    }
    setBusy(true);
    try {
      // PDFs are passed through; images are compressed.
      const isPdf = file.type === "application/pdf";
      const body: Blob = isPdf ? file : await compressOnly(file);
      const contentType = isPdf ? "application/pdf" : "image/jpeg";

      const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
        `${base}/receipt/upload-url`,
        { fileName: file.name, contentType },
      );
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        body,
        headers: { "Content-Type": contentType },
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
      }
      const updated = await apiPost<{
        id: string;
        receiptR2Key: string;
        receiptFileName: string | null;
        receiptContentType: string | null;
        receiptUploadedAt: string;
      }>(`${base}/receipt`, {
        key,
        fileName: file.name,
        contentType,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Receipt attached." });
      onChanged?.({
        receiptR2Key: updated.receiptR2Key,
        receiptFileName: updated.receiptFileName,
        receiptContentType: updated.receiptContentType,
        receiptUploadedAt: updated.receiptUploadedAt,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Upload failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleView() {
    if (!base) return;
    try {
      const { url } = await apiGet<{ url: string }>(
        `${base}/receipt-url`,
      );
      // Open in a new tab — the URL is presigned, expires in an hour.
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't open receipt.", err),
      });
    }
  }

  async function handleDelete() {
    if (!base) return;
    if (!confirm("Remove this receipt?")) return;
    setBusy(true);
    try {
      await apiDelete(`${base}/receipt`);
      publishInlineMessage({ type: "SUCCESS", text: "Receipt removed." });
      onChanged?.({
        receiptR2Key: null,
        receiptFileName: null,
        receiptContentType: null,
        receiptUploadedAt: null,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Remove failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  // Hidden file inputs + visible action buttons. We don't preview thumbnails
  // here — receipts are usually long, and a presigned GET is cheap so users
  // can pop them open in a new tab when they need to verify.
  //
  // Two inputs:
  //   1. fileInputId — generic "pick from disk / photo library" picker
  //      (accept includes PDFs)
  //   2. cameraInputId — `capture="environment"` directs mobile browsers
  //      to open the rear camera straight to a viewfinder. On desktop
  //      browsers the capture attribute is silently ignored and it
  //      behaves like the regular picker.
  const fileInputId = `receipt-file-${businessExpenseId ?? "pending"}`;
  const cameraInputId = `receipt-camera-${businessExpenseId ?? "pending"}`;

  if (compact) {
    return (
      <HStack gap={2} fontSize="xs" wrap="wrap">
        {hasReceipt ? (
          <>
            <HStack gap={1} color="green.700">
              <Paperclip size={12} />
              <Text fontSize="xs">{existing?.receiptFileName ?? "Receipt"}</Text>
            </HStack>
            <Button size="xs" variant="ghost" onClick={handleView} title="View receipt">
              <Eye size={12} />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              colorPalette="red"
              onClick={handleDelete}
              loading={busy}
              title="Remove receipt"
            >
              <Trash2 size={12} />
            </Button>
          </>
        ) : (
          <>
            <input
              id={fileInputId}
              type="file"
              accept="image/*,application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <input
              id={cameraInputId}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
                e.target.value = "";
              }}
            />
            <Button
              size="xs"
              variant="outline"
              onClick={() => document.getElementById(cameraInputId)?.click()}
              loading={busy}
              disabled={!businessExpenseId}
              title={!businessExpenseId ? "Save the expense first" : "Take a photo of the receipt"}
            >
              <Camera size={12} /> Take photo
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => document.getElementById(fileInputId)?.click()}
              loading={busy}
              disabled={!businessExpenseId}
              title={!businessExpenseId ? "Save the expense first" : "Attach a receipt photo or PDF"}
            >
              <Paperclip size={12} /> Attach receipt
            </Button>
          </>
        )}
      </HStack>
    );
  }

  return (
    <Box>
      <HStack gap={2} mb={1}>
        <Text fontSize="sm" fontWeight="medium">Receipt</Text>
        <Text fontSize="xs" color="fg.muted">(optional)</Text>
      </HStack>
      {hasReceipt ? (
        <HStack
          gap={2}
          p={2}
          borderWidth="1px"
          borderColor="green.200"
          bg="green.50"
          borderRadius="md"
          fontSize="sm"
        >
          <Paperclip size={14} color="var(--chakra-colors-green-700)" />
          <Text flex="1" minW={0} truncate>
            {existing?.receiptFileName ?? "Receipt attached"}
          </Text>
          <Button size="xs" variant="ghost" onClick={handleView} title="Open in new tab">
            <Eye size={12} /> View
          </Button>
          <Button
            size="xs"
            variant="ghost"
            colorPalette="red"
            onClick={handleDelete}
            loading={busy}
            title="Remove receipt"
          >
            <Trash2 size={12} />
          </Button>
        </HStack>
      ) : (
        <>
          <input
            id={fileInputId}
            type="file"
            accept="image/*,application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
          />
          <input
            id={cameraInputId}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
          />
          <HStack gap={2} wrap="wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => document.getElementById(cameraInputId)?.click()}
              loading={busy}
              disabled={!businessExpenseId}
            >
              <Camera size={14} /> Take photo
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => document.getElementById(fileInputId)?.click()}
              loading={busy}
              disabled={!businessExpenseId}
            >
              <Upload size={14} /> {businessExpenseId ? "Upload receipt" : "Save first to attach"}
            </Button>
          </HStack>
        </>
      )}
    </Box>
  );
}
