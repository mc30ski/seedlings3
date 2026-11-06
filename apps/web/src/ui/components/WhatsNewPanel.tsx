"use client";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW — the list you can go back to.
//
// The bar announces each change once and then never again, which is right for
// a bar and wrong as the only way to see one: a notice you get exactly one
// shot at, on a busy morning, is a notice most people miss. Worse, there was
// no way to see a change a second time at all — skip it once and the feature
// was simply something you had never been told about.
//
// So every announcement this person is allowed to see is listed here, in
// order, with the ones they have already answered marked as such, and any of
// them can be replayed. "Show me" runs exactly what the bar's button runs.
//
// ON PROFILE, NOT SETTINGS. Settings needs `settings.view`; a field worker
// does not have it and would have no way back to their own release notes.
// Profile is reachable by every account there is.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, Card, HStack, Text, VStack } from "@chakra-ui/react";
import { Sparkles } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import { WHATS_NEW, WHATS_NEW_CHANGED, notifyWhatsNewChanged } from "@/src/lib/whatsNew";
import { spotlightFeature } from "@/src/lib/featureSpotlight";
import { fmtDate } from "@/src/lib/dates";

export default function WhatsNewPanel({ can }: { can: (capability: string) => boolean }) {
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ seen: string[] }>("/api/me/feature-announcements");
      setSeen(new Set(res.seen ?? []));
    } catch {
      setSeen(new Set());
    }
  }, []);

  useEffect(() => {
    void load();
    // Reload when the bar is answered, so the two never disagree about
    // whether a change has been read.
    const onChanged = () => void load();
    window.addEventListener(WHATS_NEW_CHANGED, onChanged);
    return () => window.removeEventListener(WHATS_NEW_CHANGED, onChanged);
  }, [load]);

  // Only what this person could actually use, same rule as the bar —
  // listing a feature somebody cannot open is worse than staying quiet.
  const entries = WHATS_NEW.filter((e) => e.requires === null || can(e.requires));
  if (entries.length === 0) return null;

  async function showMe(entry: (typeof WHATS_NEW)[number]) {
    if (!entry.showMe) return;
    setBusy(entry.id);
    try {
      // Recorded as shown, exactly as the bar does, so replaying a change
      // also clears it from the bar rather than leaving it to reappear.
      await apiPost(`/api/me/feature-announcements/${encodeURIComponent(entry.id)}`, { action: "shown" });
      notifyWhatsNewChanged();
    } catch { /* the walkthrough matters more than the bookkeeping */ }
    setBusy(null);
    window.dispatchEvent(
      new CustomEvent("navigate:staffTab", {
        detail: { tab: entry.showMe.tab, category: entry.showMe.category },
      }),
    );
    if (entry.showMe.spotlight !== false) spotlightFeature(entry.id);
  }

  async function unsee(id?: string) {
    setBusy(id ?? "__all__");
    try {
      await apiDelete(id ? `/api/me/feature-announcements/${encodeURIComponent(id)}` : "/api/me/feature-announcements");
      await load();
      notifyWhatsNewChanged();
    } catch { /* leave the list as it was */ }
    setBusy(null);
  }

  const anySeen = !!seen && entries.some((e) => seen.has(e.id));

  return (
    <Card.Root variant="outline" data-testid="whats-new-panel">
      <Card.Header py="2" px="3" pb="0">
        <HStack justify="space-between" align="center">
          <HStack gap={2}>
            <Box color="blue.fg"><Sparkles size={15} /></Box>
            <Text fontWeight="semibold">What&rsquo;s new</Text>
          </HStack>
          {anySeen && (
            <Button
              size="2xs"
              variant="ghost"
              loading={busy === "__all__"}
              onClick={() => void unsee()}
              data-testid="whats-new-reset-all"
            >
              Show all again
            </Button>
          )}
        </HStack>
      </Card.Header>
      <Card.Body py="2" px="3">
        <VStack align="stretch" gap={2}>
          <Text fontSize="xs" color="fg.muted">
            Changes to the app. Open one again any time.
          </Text>
          {entries.map((e) => {
            const done = !!seen?.has(e.id);
            return (
              <Box
                key={e.id}
                borderWidth="1px"
                borderColor={done ? "border" : "blue.emphasized"}
                bg={done ? undefined : "blue.faint"}
                borderRadius="md"
                p={2}
                data-testid={`whats-new-row-${e.id}`}
                data-seen={done ? "1" : "0"}
              >
                <VStack align="stretch" gap={1}>
                  <HStack gap={2} wrap="wrap">
                    <Text fontSize="sm" fontWeight="semibold">{e.headline}</Text>
                    {!done && <Badge size="sm" colorPalette="blue" variant="solid">New</Badge>}
                    <Text fontSize="2xs" color="fg.muted">{fmtDate(e.shippedOn)}</Text>
                  </HStack>
                  <Text fontSize="xs" color="fg.muted">{e.body}</Text>
                  <HStack gap={2} justify="flex-end" wrap="wrap">
                    {done && (
                      <Button
                        size="2xs"
                        variant="ghost"
                        loading={busy === e.id}
                        onClick={() => void unsee(e.id)}
                      >
                        Mark unread
                      </Button>
                    )}
                    {e.showMe && (
                      <Button
                        size="2xs"
                        colorPalette="blue"
                        loading={busy === e.id}
                        onClick={() => void showMe(e)}
                        data-testid={`whats-new-replay-${e.id}`}
                      >
                        Show me
                      </Button>
                    )}
                  </HStack>
                </VStack>
              </Box>
            );
          })}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
