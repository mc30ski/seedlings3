"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GuideMediaLibrary — upload and manage in-app images and video.
//
// Canonical spec: docs/features/education.md
//
// TWO RULES THIS UI EXISTS TO MAKE VISIBLE:
//
//   1. VIDEO IS SUPER-ONLY. Admins see every video and can reference any
//      of them in a page; only a Super can add or remove one. Video is the
//      single asset class that can quietly become expensive, and the only
//      one with a format trap worth concentrating in one uploader.
//
//   2. ASSETS ARE IMMUTABLE. There is no "replace" — replacing an image
//      under an approved page would change published content without an
//      approver seeing it. You upload a new asset and edit the page, which
//      re-enters review.
//
// Deletion is reference-checked server-side; the error names the guides
// still pointing at the file rather than leaving a worker with a broken
// page in a field.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Box, Button, HStack, Input, Text, VStack } from "@chakra-ui/react";
import { Image as ImageIcon, Video, ExternalLink} from "lucide-react";
import { Dashboard } from "@/src/ui/components/Dashboard";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { apiGet } from "@/src/lib/api";
import {
  fetchAssets,
  presignAsset,
  finalizeAsset,
  deleteAsset,
  assetToken,
  fmtBytes,
  type GuideAsset,
  type MediaLimits,
} from "@/src/lib/guides";

export default function GuideMediaLibrary({
  showSuperExtras,
  limits,
}: {
  showSuperExtras: boolean;
  limits: MediaLimits | null;
}) {
  const [assets, setAssets] = useState<GuideAsset[] | null>(null);
  /** Asset whose signed URL is being fetched, so only that row spins. */
  const [viewing, setViewing] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // From the server, not a copy of its constant — a duplicated page size
  // silently breaks the page count the moment the API's default moves.
  const [pageSize, setPageSize] = useState(20);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [deleteFor, setDeleteFor] = useState<GuideAsset | null>(null);
  const [pendingOverride, setPendingOverride] = useState<{ file: File; message: string } | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetchAssets({ q: q.trim() || undefined, page });
      setAssets(res.items);
      setTotal(res.total);
      setPageSize(res.pageSize);
      // Deleting the last row on the final page, or narrowing a search,
      // can leave us past the end. Step back rather than showing an empty
      // list under a pager that says there is more.
      const lastPage = Math.max(1, Math.ceil(res.total / res.pageSize));
      if (page > lastPage) setPage(lastPage);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load media.", err) });
      setAssets([]);
      setTotal(0);
    } finally {
      setBusy(false);
    }
  }, [q, page]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // A new search is a new result set — staying on page 3 of the old one
  // shows nothing and reads as "no matches".
  useEffect(() => {
    setPage(1);
  }, [q]);

  const upload = useCallback(
    async (file: File, overrideSizeLimit = false) => {
      setBusy(true);
      try {
        const pre = await presignAsset({
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          overrideSizeLimit,
        });

        // Over the soft video guideline — ask before spending the bytes,
        // and record the answer server-side when it lands.
        if (pre.requiresOverride) {
          setPendingOverride({ file, message: pre.warning ?? "This file is over the size guideline." });
          return;
        }
        if (pre.warning) {
          publishInlineMessage({ type: "INFO", text: pre.warning });
        }

        const put = await fetch(pre.uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);

        await finalizeAsset({
          r2Key: pre.r2Key,
          contentType: file.type,
          originalFilename: file.name,
        });
        publishInlineMessage({ type: "SUCCESS", text: `${file.name} added.` });
        await load();
      } catch (err) {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  async function remove(asset: GuideAsset) {
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      publishInlineMessage({ type: "SUCCESS", text: "Media deleted." });
      await load();
    } catch (err) {
      // A 409 here names the guides still using it — surface that verbatim
      // rather than a generic failure.
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't delete.", err) });
    } finally {
      setBusy(false);
    }
  }

  const count = total;
  const shown = assets?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Box mb={3}>
      <Dashboard
        storageKey="seedlings:guidesTab:mediaOpen"
        title="Media library"
        icon={ImageIcon}
        variant="neutral"
        defaultOpen={false}
        onRefresh={load}
        refreshing={busy}
        collapsedSummarySlot={
          <Text fontSize="xs" color="gray.700" lineClamp={1}>
            {count} file{count === 1 ? "" : "s"}
          </Text>
        }
      >
        <VStack align="stretch" gap={2}>
          <HStack gap={2} wrap="wrap">
            <Input
              size="sm"
              placeholder="Search media…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              flex="1"
              minW="160px"
            />
            <Button size="xs" variant="outline" onClick={() => imageInput.current?.click()} loading={busy}>
              <ImageIcon size={12} /> Add image
            </Button>
            {/* Super-only. Admins still SEE every video below and can
                reference one in a page — they just can't add or remove. */}
            {showSuperExtras && (
              <Button size="xs" variant="outline" onClick={() => videoInput.current?.click()} loading={busy}>
                <Video size={12} /> Add video
              </Button>
            )}
          </HStack>

          {limits && (
            <Text fontSize="2xs" color="fg.muted">
              Images up to {fmtBytes(limits.imageMaxBytes)}
              {showSuperExtras
                ? ` · video guideline ${fmtBytes(limits.videoMaxBytes)}, hard cap ${fmtBytes(limits.videoHardCeilingBytes)}`
                : " · video is added by a Super"}
            </Text>
          )}

          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <input
            ref={videoInput}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />

          {shown === 0 ? (
            <Text fontSize="xs" color="fg.muted">
              Nothing uploaded yet. Images and video added here can be referenced from any guide.
            </Text>
          ) : (
            <VStack align="stretch" gap={1}>
              {(assets ?? []).map((a) => (
                <HStack
                  key={a.id}
                  gap={2}
                  p={2}
                  borderWidth="1px"
                  borderColor="gray.200"
                  rounded="md"
                  wrap="wrap"
                >
                  <Badge size="sm" colorPalette={a.kind === "VIDEO" ? "purple" : "blue"} variant="subtle">
                    {a.kind === "VIDEO" ? "Video" : "Image"}
                  </Badge>
                  <Text fontSize="xs" flex="1" minW="120px" lineClamp={1}>
                    {a.originalFilename}
                  </Text>
                  <Text fontSize="2xs" color="fg.muted">
                    {fmtBytes(a.sizeBytes)}
                    {a.sizeOverride ? " · over guideline" : ""}
                  </Text>
                  <Text fontSize="2xs" color="fg.muted">
                    {a.uploadedByName ?? "—"}
                  </Text>
                  {/* VIEW — opens the actual file in a new tab.
                      The library listed name, size and uploader but gave no
                      way to SEE the thing, so identifying an asset meant
                      pasting its markdown into a guide and previewing.
                      Fetched on click rather than up front: these are signed,
                      short-lived URLs, and minting one per row on every render
                      would be a request per asset for links mostly never used. */}
                  <Button
                    size="xs"
                    variant="ghost"
                    title={`Open ${a.originalFilename} in a new tab`}
                    loading={viewing === a.id}
                    onClick={async () => {
                      setViewing(a.id);
                      try {
                        const { url } = await apiGet<{ url: string }>(`/api/me/guides/assets/${a.id}/url`);
                        window.open(url, "_blank", "noopener,noreferrer");
                      } catch (err) {
                        publishInlineMessage({
                          type: "ERROR",
                          text: getErrorMessage("Couldn't open that file.", err),
                        });
                      } finally {
                        setViewing(null);
                      }
                    }}
                  >
                    <ExternalLink size={12} /> View
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        a.kind === "VIDEO"
                          ? `:::video ${assetToken(a.id)}`
                          : `![${a.altText ?? a.originalFilename}](${assetToken(a.id)})`,
                      );
                      publishInlineMessage({ type: "SUCCESS", text: "Markdown copied — paste it into a guide." });
                    }}
                  >
                    Copy markdown
                  </Button>
                  {a.canManage && (
                    <Button size="xs" variant="outline" colorPalette="red" onClick={() => setDeleteFor(a)}>
                      Delete
                    </Button>
                  )}
                </HStack>
              ))}
            </VStack>
          )}

          {/* The range line renders even on a single page. Hiding the whole
              footer when everything fits made the library look unpaged and
              gave no answer to "how many are there?" — the count is useful
              at any size. Prev/Next appear only when they can do
              something. */}
          {shown > 0 && (
            <HStack gap={2} justify="center" pt={1} wrap="wrap">
              {totalPages > 1 && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={page <= 1 || busy}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </Button>
              )}
              <Text color="fg.muted" fontSize="xs">
                {totalPages > 1
                  ? `${(page - 1) * pageSize + 1}–${(page - 1) * pageSize + shown} of ${total} · page ${page} of ${totalPages}`
                  : `${total} file${total === 1 ? "" : "s"}`}
              </Text>
              {totalPages > 1 && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={page >= totalPages || busy}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next →
                </Button>
              )}
            </HStack>
          )}
        </VStack>
      </Dashboard>

      <ConfirmDialog
        open={!!deleteFor}
        title="Delete this media?"
        message={`"${deleteFor?.originalFilename}" will be removed from storage. If any guide still references it, the delete is refused and you'll be told which.`}
        confirmLabel="Delete"
        confirmColorPalette="red"
        onConfirm={() => {
          const a = deleteFor;
          setDeleteFor(null);
          if (a) void remove(a);
        }}
        onCancel={() => setDeleteFor(null)}
      />

      <ConfirmDialog
        open={!!pendingOverride}
        title="This video is over the guideline"
        message={`${pendingOverride?.message ?? ""} Uploading it anyway is recorded in the audit log with your name.`}
        warning="Large video costs storage and is slow for workers on cellular."
        confirmLabel="Upload anyway"
        confirmColorPalette="orange"
        onConfirm={() => {
          const p = pendingOverride;
          setPendingOverride(null);
          if (p) void upload(p.file, true);
        }}
        onCancel={() => setPendingOverride(null)}
      />
    </Box>
  );
}
