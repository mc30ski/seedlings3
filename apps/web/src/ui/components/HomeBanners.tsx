"use client";

import { useEffect, useState } from "react";
import { Box, Button, Card, HStack, Text, VStack } from "@chakra-ui/react";
import { Megaphone, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

type Banner = {
  id: string;
  title: string | null;
  body: string;
  createdAt: string;
  createdBy?: { id: string; displayName: string | null; email: string | null } | null;
};

/**
 * Renders the current user's pending home banners, stacked newest-first.
 * Each banner has a Dismiss (✕) action that removes it from the user's
 * own view — dismissals are per-user and don't affect anyone else.
 *
 * Hidden when the admin Home tab is impersonating someone else (viewing
 * as a different worker). The data we fetch is always the *current* user's
 * banners, so showing them while impersonating would be misleading.
 */
export default function HomeBanners({ disabled }: { disabled?: boolean }) {
  const [banners, setBanners] = useState<Banner[]>([]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  async function load() {
    try {
      const list = await apiGet<Banner[]>("/api/banners");
      setBanners(Array.isArray(list) ? list : []);
    } catch {
      // Soft-fail — banners are non-critical UX; don't block the rest of
      // the Home dashboard if this single endpoint hiccups.
      setBanners([]);
    }
  }

  useEffect(() => {
    if (disabled) return;
    void load();
    // Reload when the tab regains focus so the dismiss state stays fresh
    // across cross-device sessions.
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [disabled]);

  async function dismiss(id: string) {
    setDismissingId(id);
    // Optimistic — remove from local state before the API call returns so the
    // tap feels instant. If the call fails we put it back.
    const prev = banners;
    setBanners((b) => b.filter((x) => x.id !== id));
    try {
      await apiPost(`/api/banners/${id}/dismiss`);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Could not dismiss.", err) });
      setBanners(prev);
    } finally {
      setDismissingId(null);
    }
  }

  if (disabled || banners.length === 0) return null;

  return (
    <VStack align="stretch" gap={2}>
      {banners.map((b) => (
        <Card.Root key={b.id} variant="outline" bg="blue.50" borderColor="blue.300" borderWidth="1px">
          <Card.Body p={3}>
            <HStack align="start" gap={3}>
              <Box flexShrink={0} color="blue.600" mt="2px"><Megaphone size={16} /></Box>
              <VStack align="start" gap={0} flex="1" minW={0}>
                {b.title && (
                  <Text fontSize="sm" fontWeight="semibold" color="blue.900">{b.title}</Text>
                )}
                <Text fontSize="sm" color="blue.900" whiteSpace="pre-wrap">{b.body}</Text>
                {b.createdBy?.displayName && (
                  <Text fontSize="xs" color="blue.700" mt={1}>
                    — {b.createdBy.displayName}
                  </Text>
                )}
              </VStack>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => dismiss(b.id)}
                loading={dismissingId === b.id}
                px="1"
                minW="0"
              >
                <X size={14} />
              </Button>
            </HStack>
          </Card.Body>
        </Card.Root>
      ))}
    </VStack>
  );
}
