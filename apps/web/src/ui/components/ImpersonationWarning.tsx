"use client";

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import { getPerspectiveName } from "@/src/lib/impersonation";

// ─────────────────────────────────────────────────────────────────────────
// ImpersonationWarning — inline red callout placed at the top of any
// mutation-confirm dialog where the actor is acting on behalf of another
// user, so the impact lands on someone else's record.
//
// Two distinct impersonation paths can be active simultaneously; this
// component renders whichever apply:
//
//   1. viewAsUserId — the actor is viewing-as a specific worker (Admin
//      Worker Home, JobsTab w/ viewAsUserIds, Equipment "on behalf of").
//      Mutations there get attributed to / affect the impersonated
//      worker's record. Caller passes the worker's display name as
//      `viewAsName` so the warning can name them.
//
//   2. An active PERSPECTIVE — the actor has narrowed themselves to one of
//      their other roles. Doesn't change the actor's userId; included so the
//      operator knows which view they are acting from.
//
//      ITS COPY SAID "The audit log flags this action as impersonated",
//      and that was false twice over. A perspective impersonates nobody —
//      it can only narrow what you already hold, never act on another
//      person's record — and nothing was written to the audit row about it
//      either, so the sentence promised a trail that did not exist. The
//      app's own Help text said the opposite and was right. Perspectives
//      ARE recorded now (see `requestContext.ts` and `writeAudit`), and
//      the actor is still you, which is what this says.
//
// Renders nothing when neither path is active.
//
// Usage:
//   <ImpersonationWarning viewAsName={impersonatedWorker?.displayName} />
//
// The viewAsName prop is the source of truth for path 1; path 2 reads the
// display-only cached perspective name, because this renders inside dialogs that
// have no access to `me`.
// ─────────────────────────────────────────────────────────────────────────

type Props = {
  /**
   * Display name of the worker whose record will be mutated by the
   * confirm action. Pass null/undefined when the actor is acting on
   * their own record (the warning's path-1 message is suppressed). The
   * perspective warning still fires if a perspective is active.
   */
  viewAsName?: string | null;
};

export default function ImpersonationWarning({ viewAsName }: Props) {
  const roleLabel = getPerspectiveName();
  if (!viewAsName && !roleLabel) return null;
  return (
    <Box
      p={2}
      mb={2}
      bg="red.faint"
      borderLeftWidth="3px"
      borderColor="red.500"
      borderRadius="md"
    >
      <HStack gap={2} align="flex-start">
        <Box pt={0.5}>
          <AlertTriangle size={14} color="var(--chakra-colors-red-600)" />
        </Box>
        <VStack align="start" gap={0.5}>
          {viewAsName && (
            <Text fontSize="xs" color="red.fg">
              <b>Acting as worker: {viewAsName}.</b> This will save to{" "}
              <b>{viewAsName}</b>'s record, not yours. Audit log captures you as the actor.
            </Text>
          )}
          {roleLabel && (
            <Text fontSize="xs" color="red.fg">
              <b>Viewing as: {roleLabel}.</b> The action runs with your full
              authority, and the audit records you.
            </Text>
          )}
        </VStack>
      </HStack>
    </Box>
  );
}
