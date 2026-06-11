"use client";

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import { getImpersonation, IMPERSONATION_LABELS } from "@/src/lib/impersonation";

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
//   2. X-Impersonate-As header (role override) — Super using the global
//      "view as Admin / Worker" picker. Doesn't change the actor's
//      userId; included as a secondary warning so the audit context is
//      obvious to the operator at the moment of action.
//
// Renders nothing when neither path is active.
//
// Usage:
//   <ImpersonationWarning viewAsName={impersonatedWorker?.displayName} />
//
// The viewAsName prop is the source of truth for path 1; path 2 reads
// localStorage internally via getImpersonation().
// ─────────────────────────────────────────────────────────────────────────

type Props = {
  /**
   * Display name of the worker whose record will be mutated by the
   * confirm action. Pass null/undefined when the actor is acting on
   * their own record (the warning's path-1 message is suppressed). The
   * role-impersonation banner still fires if X-Impersonate-As is set.
   */
  viewAsName?: string | null;
};

export default function ImpersonationWarning({ viewAsName }: Props) {
  const roleTarget = getImpersonation();
  const roleLabel = roleTarget ? (IMPERSONATION_LABELS[roleTarget] ?? roleTarget) : null;
  if (!viewAsName && !roleLabel) return null;
  return (
    <Box
      p={2}
      mb={2}
      bg="red.50"
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
            <Text fontSize="xs" color="red.900">
              <b>Acting as worker: {viewAsName}.</b> This will save to{" "}
              <b>{viewAsName}</b>'s record, not yours. Audit log captures you as the actor.
            </Text>
          )}
          {roleLabel && (
            <Text fontSize="xs" color="red.900">
              <b>Role impersonation: {roleLabel}.</b> The audit log flags this action as
              impersonated.
            </Text>
          )}
        </VStack>
      </HStack>
    </Box>
  );
}
