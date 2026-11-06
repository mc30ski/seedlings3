"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE "WHAT'S NEW" BAR — one shipped change, announced once, to the people
// who can use it.
//
// WHY A BAR AND NOT A DIALOG. It appears on the first load after a deploy,
// which for most of this company is a worker opening the app at seven in the
// morning to clock in. A modal would stand between them and the button they
// came for, every release. A strip under the header is read by whoever is
// curious and stepped past by whoever is not — and stepping past is a real
// answer, which is why Skip records itself rather than leaving the bar to
// return tomorrow.
//
// ONE AT A TIME. See `nextAnnouncement` — three stacked on a phone is a wall.
//
// EVERYTHING ELSE IS IN `whatsNew.ts`. This file never names a feature; a new
// announcement is one entry in that registry and nothing here changes.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Text, VStack } from "@chakra-ui/react";
import { Sparkles, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { WHATS_NEW_CHANGED, nextAnnouncement, notifyWhatsNewChanged, type WhatsNewEntry } from "@/src/lib/whatsNew";
import { spotlightFeature } from "@/src/lib/featureSpotlight";

export default function WhatsNewBar({
  can,
  /** True while looking at somebody else's screen. Their unread notices are
   *  not yours to read, and certainly not yours to mark read — the account
   *  would then never be told. The server refuses to scope this by view-as
   *  for the same reason; this is the matching half in the UI. */
  disabled,
}: {
  can: (capability: string) => boolean;
  disabled?: boolean;
}) {
  /**
   * THE SEEN SET IS THE ONLY STATE, and the bar is derived from it.
   *
   * There was a second piece of state — an `answered` boolean, set on the
   * click so the bar vanished without waiting for the round trip. It
   * latched for the life of the page: pressing "Show all again" on Profile
   * deleted the rows, the list updated, and coming back to the tab still
   * showed no bar, because a boolean from twenty minutes ago said this
   * session had already answered. The only way back was a full reload, and
   * needing to reload an app to see the thing that tells you what changed
   * is worse than not having it.
   *
   * Now the click adds the id to this set, which hides the bar just as
   * instantly, and a reload of the set is all it takes to bring it back.
   */
  const [seen, setSeen] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ seen: string[] }>("/api/me/feature-announcements");
      // STORE THE ANSWER, CHOOSE LATER. Picking the entry here would freeze
      // the choice against whatever `can` said at that instant, and
      // capabilities arrive with `/api/me`, which can land after this.
      setSeen(new Set(res.seen ?? []));
    } catch {
      // SILENT. A release note is the least important thing on the page; if
      // the call fails there is simply no bar, and the next load tries
      // again. It must never produce an error banner of its own.
    }
  }, []);

  useEffect(() => {
    if (disabled) return;
    void load();
    // THE SAME ROWS, CHANGED SOMEWHERE ELSE. "Show all again" and "Mark
    // unread" live on Profile and delete the very rows this reads; without
    // listening, the bar is a snapshot of what was true when the page
    // loaded. Also covers the reverse — answering in one place and seeing
    // the other agree.
    const onChanged = () => void load();
    window.addEventListener(WHATS_NEW_CHANGED, onChanged);
    return () => window.removeEventListener(WHATS_NEW_CHANGED, onChanged);
  }, [disabled, load]);

  const answer = useCallback(
    async (id: string, action: "shown" | "skipped") => {
      // Optimistic: hide it on the click, not when the round trip lands.
      setSeen((prev) => new Set([...(prev ?? []), id]));
      try {
        await apiPost(`/api/me/feature-announcements/${encodeURIComponent(id)}`, { action });
        // The list on Profile is the same row seen from somewhere else.
        notifyWhatsNewChanged();
      } catch {
        // Also silent, and deliberately NOT rolled back. If the write failed
        // the bar returns on the next load, which is the safe direction to
        // fail: a notice shown twice is a small annoyance, a notice that
        // cannot be dismissed is a thing you learn to ignore.
      }
    },
    [],
  );

  const entry: WhatsNewEntry | null = seen ? nextAnnouncement(seen, can) : null;
  if (disabled || !entry) return null;

  return (
    <Box mx={3} mt={3}>
      {/* NOT ANOTHER NOTICE STRIP.
          Every informational banner in this app is the same object: an
          `X.faint` fill inside a 1px `X.emphasized` border. Blue is the
          operator's own announcements, orange the workday and mileage
          prompts, yellow the filter notices, red the failures. Built to
          that recipe this read as one more thing the page was telling you
          — and it is not: it is the app saying it has CHANGED, which
          happens a handful of times a year and is worth a look.
          So it breaks the recipe deliberately, in three ways that do not
          rely on noticing a hue: a solid bar down the side rather than a
          hairline all round, a filled badge and disc instead of a tint,
          and a lift off the page. Purple because it is the one palette no
          strip at this level has taken. */}
      <Box
        borderWidth="1px"
        borderColor="purple.emphasized"
        borderLeftWidth="5px"
        borderLeftColor="purple.solid"
        bg="purple.subtle"
        borderRadius="md"
        boxShadow="sm"
        p={3}
        data-testid="whats-new-bar"
        data-announcement={entry.id}
      >
        <HStack align="start" gap={3}>
          {/* A filled disc, where the notice strips all use a bare icon
              sitting in the tint. */}
          <Box
            flexShrink={0}
            mt="1px"
            w="26px"
            h="26px"
            borderRadius="full"
            bg="purple.solid"
            color="purple.contrast"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Sparkles size={14} />
          </Box>
          <VStack align="stretch" gap={1} flex="1" minW={0}>
            <HStack gap={2} wrap="wrap">
              <Badge size="sm" colorPalette="purple" variant="solid" letterSpacing="wide">
                NEW
              </Badge>
              <Text fontSize="sm" fontWeight="bold" color="purple.fg">
                {entry.headline}
              </Text>
            </HStack>
            <Text fontSize="xs" color="fg.muted">{entry.body}</Text>
            {/* THE BUTTONS WRAP ONTO THEIR OWN ROW ON A PHONE. Beside a
                two-line body at 390px they squeezed the text into a column
                four words wide. */}
            <HStack gap={2} justify="flex-end" wrap="wrap" mt={1}>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void answer(entry.id, "skipped")}
                data-testid="whats-new-skip"
              >
                <X size={13} />
                <Box as="span" ml={1}>Skip</Box>
              </Button>
              {entry.showMe && (
                <Button
                  size="xs"
                  colorPalette="purple"
                  data-testid="whats-new-show"
                  onClick={() => {
                    // Recorded as `shown` BEFORE navigating: the jump
                    // re-renders the shell and unmounts this bar, and an
                    // await after that point is a promise nobody is left to
                    // hold. The request is already in flight by then.
                    void answer(entry.id, "shown");
                    window.dispatchEvent(
                      new CustomEvent("navigate:staffTab", {
                        detail: { tab: entry.showMe!.tab, category: entry.showMe!.category },
                      }),
                    );
                    // THE NAVIGATION IS ONLY HALF. Fired unconditionally,
                    // including when the jump was a no-op because they were
                    // already on that tab — which is the case where the
                    // navigation alone did nothing whatsoever. The spotlight
                    // waits for the control to exist, so it does not matter
                    // that the tab has not finished switching yet.
                    if (entry.showMe!.spotlight !== false) spotlightFeature(entry.id);
                  }}
                >
                  Show me
                </Button>
              )}
            </HStack>
          </VStack>
        </HStack>
      </Box>
    </Box>
  );
}
