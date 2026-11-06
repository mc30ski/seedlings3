"use client";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW, in the header drawer.
//
// The list lives on Profile, which is the right home for it and four taps
// away from wherever you are. This is the shortcut: one control in the strip
// that already holds Appearance and Today's board, carrying a dot when there
// is something unread.
//
// IT DOES NOT OPEN A MENU. The strip's own note says the row above it sets
// `line-height: 0` and that dropdowns placed in here have collapsed to their
// padding twice. A control that jumps to the list it is a shortcut for has
// nothing to collapse.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Box } from "@chakra-ui/react";
import { Sparkles } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { WHATS_NEW, WHATS_NEW_CHANGED } from "@/src/lib/whatsNew";
import { revealElement } from "@/src/lib/featureSpotlight";

export default function WhatsNewHeaderButton({
  can,
  label,
}: {
  can: (capability: string) => boolean;
  /** Rendered INSIDE the control, never beside it — a caption that is not
   *  part of the button is the one place a click does nothing, and it is
   *  the bigger target of the two. Same rule as Today's board. */
  label?: string;
}) {
  /**
   * The SEEN SET is the state; the count is derived during render.
   *
   * This stored the count instead, computed inside the fetch — which meant
   * it was computed once, against whatever `can` answered at that moment.
   * Capabilities arrive with `/api/me`, after this mounts, so `can` answered
   * false for everything and the count was permanently 0: the dot never
   * appeared, for anybody, and nothing failed. Deriving it in render means
   * the answer corrects itself the moment the capabilities land.
   */
  const [seen, setSeen] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ seen: string[] }>("/api/me/feature-announcements");
      setSeen(new Set(res.seen ?? []));
    } catch {
      // Silent: a release-note count is the least important thing in the
      // header and must never put an error in it.
      setSeen(new Set());
    }
  }, []);

  useEffect(() => {
    void load();
    // The bar and the Profile list write the same rows this counts.
    const onChanged = () => void load();
    window.addEventListener(WHATS_NEW_CHANGED, onChanged);
    return () => window.removeEventListener(WHATS_NEW_CHANGED, onChanged);
  }, [load]);

  const mine = WHATS_NEW.filter((e) => e.requires === null || can(e.requires));
  // Nothing to show at all — no announcements this person may see.
  if (mine.length === 0) return null;
  const unread = seen ? mine.filter((e) => !seen.has(e.id)).length : 0;

  // Matches the caption beside it. A tooltip naming a different thing from
  // the word under the cursor reads as a different control.
  const title = unread > 0 ? `Updates — ${unread} unread` : "Updates";

  return (
    <Box
      as="button"
      aria-label={title}
      title={title}
      position="relative"
      px={label ? "1.5" : "1"}
      py={1}
      gap={label ? 1.5 : 0}
      borderRadius={label ? "md" : undefined}
      display="inline-flex"
      alignItems="center"
      cursor="pointer"
      // AT REST IT IS THE HEADER'S OWN INK, exactly like Appearance beside
      // it. `gray.fg` is a generic grey with no relationship to a green
      // title bar, so this control sat at a different colour from its
      // neighbour for no reason anybody could read. Green means one thing
      // here and one only: there is something you have not seen.
      color={unread > 0 ? "green.fg" : "chrome.headerFg"}
      _hover={{ color: "green.fg" }}
      transition="color 0.1s"
      data-testid="whats-new-header"
      data-unread={unread}
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent("navigate:staffTab", { detail: { tab: "profile", category: "System" } }),
        );
        // Profile is a long page and the list is well down it, so landing on
        // the tab is not the same as landing on the thing.
        revealElement('[data-testid="whats-new-panel"]');
      }}
    >
      {/* The dot is anchored to the ICON, not the button: with a label the
          control is several times wider, and `right: 0` would put the dot
          out past the end of the word. Same fix as Today's board. */}
      <Box position="relative" display="inline-flex">
        <Sparkles size={16} />
        {unread > 0 && (
          <Box
            position="absolute"
            top="-2px"
            right="-2px"
            borderRadius="full"
            bg="green.solid"
            w="7px"
            h="7px"
          />
        )}
      </Box>
      {/* `xs`, matching Appearance and Today's board to the token. This was
          `sm` — one step larger — which is why the three captions on one row
          did not line up. */}
      {label && (
        <Box as="span" fontSize="xs" lineHeight="1.2" whiteSpace="nowrap">
          {label}
        </Box>
      )}
    </Box>
  );
}
