"use client";

// Per-user "Sign-ins & activity" widget for Super → Users.
//
// Renders inline at the bottom of each user card. Header shows the
// derived "Last signed in" timestamp (or "Never signed in") so the
// operator gets a quick at-a-glance read without expanding. Tapping
// the header expands an audit feed of every AuditEvent where this
// user is the actor — sign-in events alongside any mutation they made
// — with a Load More button that pages back in time.
//
// Self-contained state: each section owns its own page list, cursor,
// and loading flag so multiple sections can be expanded at once
// without crosstalk. Super-only at the API layer (the route is gated
// by superGuard); this component does NOT re-gate, since the
// containing UsersTab already mounts it under `!readOnly` (which the
// page wiring restricts to Super).

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ChevronDown, ChevronRight, LogIn, RefreshCw } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { fmtDateOpts, fmtTimeOpts } from "@/src/lib/lib";

type ActivityItem = {
  id: string;
  scope: string;
  verb: string;
  action: string | null;
  metadata: unknown;
  createdAt: string;
};

type ActivityPage = {
  items: ActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

type Props = {
  userId: string;
  // Server-resolved "last signed in" instant; null when the user has
  // never been seen by the auth plugin. Used purely for the header
  // pill — the expanded feed re-fetches from the audit table.
  lastSignInAt: string | null;
};

function formatRelative(iso: string | null): string {
  if (!iso) return "Never signed in";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "Just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  // date-handling-allow: elapsed-time — "days since signed in" cosmetic
  // label, ≤1-hour DST drift doesn't matter for a bucketed day count.
  const days = Math.floor(ms / 86_400_000);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatTimestamp(iso: string): string {
  return `${fmtDateOpts(iso, { month: "short", day: "numeric", year: "numeric" })} · ${fmtTimeOpts(iso, { hour: "numeric", minute: "2-digit" })}`;
}

// Pretty-print "{SCOPE}_{VERB}" → "Title Cased Words" for the chip
// label. Examples: USER + SIGN_IN → "Sign in", PAYMENT + APPROVED →
// "Payment approved", JOB + UPDATED → "Job updated". Pure cosmetic.
function entryLabel(scope: string, verb: string): string {
  if (verb === "SIGN_IN") return "Signed in";
  const scopeWord = scope.toLowerCase().replace(/_/g, " ");
  const verbWord = verb.toLowerCase().replace(/_/g, " ");
  const combined = `${scopeWord} ${verbWord}`.replace(/\s+/g, " ").trim();
  return combined.charAt(0).toUpperCase() + combined.slice(1);
}

function entryPalette(verb: string): string {
  if (verb === "SIGN_IN") return "blue";
  if (verb === "DELETED" || verb === "REJECTED") return "red";
  if (verb === "CREATED" || verb === "APPROVED") return "green";
  return "gray";
}

export default function UserActivitySection({ userId, lastSignInAt }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Initial page is fetched lazily on first expand and cached so a
  // subsequent collapse/re-expand cycle doesn't re-fetch. The whole
  // local state resets on userId change (different card), so swapping
  // between cards starts fresh.
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Reset on user change — the same React node could be reused for a
    // different user when the parent re-renders the list.
    setExpanded(false);
    setPage(null);
  }, [userId]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<ActivityPage>(`/api/super/users/${userId}/activity?limit=20`);
      setPage({
        items: r.items ?? [],
        nextCursor: r.nextCursor ?? null,
        hasMore: !!r.hasMore,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load activity.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor) return;
    setLoading(true);
    try {
      const r = await apiGet<ActivityPage>(
        `/api/super/users/${userId}/activity?limit=20&cursor=${encodeURIComponent(page.nextCursor)}`,
      );
      setPage((prev) => ({
        items: [...(prev?.items ?? []), ...(r.items ?? [])],
        nextCursor: r.nextCursor ?? null,
        hasMore: !!r.hasMore,
      }));
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load more activity.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [userId, page?.nextCursor]);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !page) void loadFirstPage();
  }

  function refresh() {
    setPage(null);
    void loadFirstPage();
  }

  return (
    <Box mt={3} pt={3} borderTopWidth="1px" borderColor="gray.200">
      {/* Header chrome matches the sibling Permissions section in
          UsersTab so the two collapsible rows line up at the same left
          edge and share the same hover-on-color affordance. Earlier
          revision wrapped the row in an `as="button"` with px+w=full
          which produced an unintended ~4px indent versus Permissions. */}
      <HStack
        gap={1}
        cursor="pointer"
        onClick={toggle}
        _hover={{ color: "fg" }}
        color="fg.muted"
        userSelect="none"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Text fontSize="xs" fontWeight="medium">Sign-ins &amp; activity</Text>
        <Badge
          size="xs"
          variant="subtle"
          colorPalette={lastSignInAt ? "blue" : "gray"}
          title={lastSignInAt ? `Last signed in ${formatTimestamp(lastSignInAt)}` : "This user has never signed in"}
        >
          <HStack gap={1} align="center">
            <LogIn size={10} />
            <Text fontSize="2xs" lineHeight="1">
              {lastSignInAt ? `Last in: ${formatRelative(lastSignInAt)}` : "Never signed in"}
            </Text>
          </HStack>
        </Badge>
      </HStack>

      {expanded && (
        <Box mt={2} pl={5}>
          {!page && loading ? (
            <HStack py={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading…</Text></HStack>
          ) : !page ? null : page.items.length === 0 ? (
            <Text fontSize="xs" color="fg.muted" py={2}>
              No recorded activity yet.
            </Text>
          ) : (
            <VStack align="stretch" gap={1}>
              {page.items.map((it) => (
                <HStack
                  key={it.id}
                  gap={2}
                  px={2}
                  py={1}
                  borderWidth="1px"
                  borderColor="gray.100"
                  borderRadius="md"
                  align="center"
                >
                  <Badge size="xs" colorPalette={entryPalette(it.verb)} variant="subtle">
                    {entryLabel(it.scope, it.verb)}
                  </Badge>
                  <Text fontSize="2xs" color="fg.muted" ml="auto">
                    {formatTimestamp(it.createdAt)}
                  </Text>
                </HStack>
              ))}
              <HStack gap={2} pt={1}>
                {page.hasMore ? (
                  <Button size="xs" variant="outline" onClick={() => void loadMore()} loading={loading}>
                    Load more
                  </Button>
                ) : (
                  <Text fontSize="2xs" color="fg.muted">
                    End of history.
                  </Text>
                )}
                <Button size="xs" variant="ghost" onClick={refresh} loading={loading} title="Refresh">
                  <RefreshCw size={10} />
                </Button>
              </HStack>
            </VStack>
          )}
        </Box>
      )}
    </Box>
  );
}
