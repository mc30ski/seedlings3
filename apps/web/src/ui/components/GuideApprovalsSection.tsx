"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GuideApprovalsSection — education guides waiting on a Super.
//
// Canonical spec: docs/features/education.md
//
// Content-only: the frame (title bar, count badge, refresh, dim) comes
// from whatever renders this — a Dashboard on the Guides tab, or the
// CollapsibleSectionCard on the Tasks page.
//
// Approving is the ONLY way a guide becomes readable, so a pending item is
// work nobody but a Super can clear — which is why it earns an alert and a
// Tasks row rather than living only inside the tab.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Text, VStack } from "@chakra-ui/react";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import {
  fetchPendingApprovals,
  approveVersion,
  rejectVersion,
  type PendingApproval,
} from "@/src/lib/guides";

/** Tell the rest of the app the review queue moved. */
export function notifyGuidesChanged() {
  try {
    window.dispatchEvent(new CustomEvent("seedlings:guides-changed"));
  } catch {
    /* SSR — nothing to notify. */
  }
}

export default function GuideApprovalsSection({
  onReady,
  onOpenGuide,
  palette = "blue",
}: {
  onReady?: (api: { refresh: () => void; loading: boolean; count: number }) => void;
  /** Open the guide being reviewed. Supplied where there is somewhere to
   *  navigate to (the Guides tab); omitted on the Tasks page, where the
   *  title stays plain rather than pretending to be a link. */
  onOpenGuide?: (slug: string) => void;
  /**
   * Colour family of the section hosting these rows, so a child card is
   * a shade of its parent rather than a white box dropped inside it.
   *
   * This section renders in two places with different accents — orange
   * inside the Guides tab's attention section, blue on the Tasks page —
   * so the host says which, and blue stays the default because that is
   * what Tasks has always shown.
   */
  palette?: string;
} = {}) {
  const [rows, setRows] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(false);
  // Approve publishes to every worker in one tap, from a list on a
  // phone, next to "Send back". It gets the same confirm as every other
  // mutation in the app.
  const [approveFor, setApproveFor] = useState<PendingApproval | null>(null);
  const [rejectFor, setRejectFor] = useState<PendingApproval | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchPendingApprovals());
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("seedlings:guides-changed", onChange);
    return () => window.removeEventListener("seedlings:guides-changed", onChange);
  }, [load]);

  useEffect(() => {
    onReady?.({ refresh: () => void load(), loading, count: rows.length });
  }, [onReady, load, loading, rows]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setLoading(true);
    try {
      await fn();
      publishInlineMessage({ type: "SUCCESS", text: ok });
      notifyGuidesChanged();
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("That didn't work.", err) });
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        Nothing waiting for review.
      </Text>
    );
  }

  return (
    <Box>
      <VStack align="stretch" gap={2}>
        {rows.map((r) => (
          <Box
            key={r.id}
            borderWidth="1px"
            /* A shade darker than the section frame, not white. A white
               card inside a coloured section reads as a different
               component sitting on top of it rather than a row of it. */
            borderColor={`${palette}.300`}
            bg={`${palette}.100`}
            rounded="md"
            p={2}
          >
            <HStack justify="space-between" align="start" gap={2} wrap="wrap">
              <VStack align="start" gap={0.5} minW="180px" flex={1}>
                <HStack gap={2} wrap="wrap">
                  {/* Approving publishes to every worker, so the reviewer
                      needs a way to READ the thing first. Without this the
                      queue asks for a decision on content it does not
                      show — only a title, a change note and an author. */}
                  <Text
                    fontSize="sm"
                    fontWeight="semibold"
                    {...(onOpenGuide
                      ? {
                          role: "link",
                          tabIndex: 0,
                          color: `${palette}.800`,
                          textDecoration: "underline",
                          cursor: "pointer",
                          onClick: () => onOpenGuide(r.guide.slug),
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onOpenGuide(r.guide.slug);
                            }
                          },
                        }
                      : {})}
                  >
                    {r.guide.title}
                  </Text>
                  {/* Solid — the subtle variant is the same fill the row
                      now uses, so it would vanish into it. */}
                  <Badge size="sm" colorPalette={palette} variant="solid">
                    v{r.versionNumber}
                  </Badge>
                </HStack>
                {/* The change note is the whole reason this is reviewable
                    without diffing — surface it, don't hide it behind a
                    click. */}
                <Text fontSize="xs" color="fg.muted">
                  {r.changeNote || "No note given"}
                </Text>
                <Text fontSize="2xs" color="fg.muted">
                  Submitted by {r.submittedBy?.displayName ?? "—"}
                </Text>
              </VStack>
              <HStack gap={2} flexShrink={0}>
                <Button
                  size="xs"
                  colorPalette="green"
                  loading={loading}
                  onClick={() => setApproveFor(r)}
                >
                  Approve
                </Button>
                <Button size="xs" variant="outline" colorPalette="red" onClick={() => setRejectFor(r)}>
                  Send back
                </Button>
              </HStack>
            </HStack>
          </Box>
        ))}
      </VStack>

      <ConfirmDialog
        open={!!approveFor}
        title="Approve and publish?"
        message={
          approveFor
            ? `Every worker can read "${approveFor.guide.title}" immediately.`
            : ""
        }
        confirmLabel="Approve & publish"
        confirmColorPalette="green"
        onConfirm={() => {
          const row = approveFor;
          setApproveFor(null);
          if (row) void act(() => approveVersion(row.id), "Approved and published.");
        }}
        onCancel={() => setApproveFor(null)}
      />

      <ConfirmDialog
        open={!!rejectFor}
        title="Send this back?"
        message="The author sees your note and can revise. Nothing workers read changes."
        inputLabel="Why"
        inputPlaceholder="Out of date for our region…"
        confirmLabel="Send back"
        confirmColorPalette="red"
        onConfirm={(value?: string) => {
          const row = rejectFor;
          setRejectFor(null);
          if (row && (value ?? "").trim()) {
            void act(() => rejectVersion(row.id, value!), "Sent back to the author.");
          }
        }}
        onCancel={() => setRejectFor(null)}
      />
    </Box>
  );
}
