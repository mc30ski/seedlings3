"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Clock } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import PolicySignWizard, { type RequiredPolicy } from "@/src/ui/dialogs/PolicySignWizard";
import { fmtDate } from "@/src/lib/lib";

type AwaitingReviewRow = RequiredPolicy & {
  signatureId: string | null;
  uploadFileName: string | null;
  uploadExpiresAt: string | null;
  uploadedAt: string | null;
};

type WorkerPoliciesResponse = {
  displayName: string | null;
  required: RequiredPolicy[];
  awaitingReview?: AwaitingReviewRow[];
};

/**
 * Global gate interceptor. Mounted once at the app root — listens for the
 * `policies:required` custom event that lib/api.ts dispatches whenever the
 * server throws POLICIES_REQUIRED, fetches the worker's fresh policies view,
 * and picks the right recovery UI:
 *
 *   1. If the pending policies are things the worker can act on right now
 *      (missing / expired / lapsed signature), open the multi-policy sign
 *      wizard filtered to those items.
 *
 *   2. If the only pending policies are AWAITING admin review (worker
 *      uploaded but admin hasn't approved yet), open a small read-only
 *      panel explaining the state. The panel is informational only —
 *      Replace / Cancel actions live exclusively on the worker's Profile
 *      tab (WorkerComplianceSection), so there's one canonical place to
 *      manage a pending upload.
 *
 *   3. If none of the pending IDs match anything in either list (the
 *      client's view has drifted from the server's), fall back to showing
 *      the full required list so the worker still gets a useful surface.
 *
 * On successful wizard completion fires `policies:signed`.
 */
export default function PolicyGateInterceptor() {
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardPolicies, setWizardPolicies] = useState<RequiredPolicy[]>([]);
  const [awaitingPanelRows, setAwaitingPanelRows] = useState<AwaitingReviewRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Tracks whether the wizard is closing because the worker just
  // signed everything vs because they cancelled. handleClose reads this
  // to decide the { completed: boolean } payload on the
  // `policies:wizard-closed` event. api.ts uses that payload to decide
  // whether to auto-retry the request that triggered the wizard.
  const completedRef = useRef(false);
  // Tracks whether a `policies:required` event has been received and
  // NOT yet answered with a `policies:wizard-closed` dispatch. api.ts
  // registers a one-shot listener the moment it dispatches
  // `policies:required`, then awaits the closed event to release the
  // caller's promise. If any code path in this component finishes the
  // cycle without dispatching, the caller hangs forever. This flag
  // guards against that: every terminal state (successful sign,
  // cancelled wizard, dismissed panel, stale-IDs fallthrough) must
  // dispatch exactly once, and this ref makes the "did we?" question
  // trivially checkable.
  const closedPendingRef = useRef(false);

  const dispatchClosedIfPending = useCallback(() => {
    if (!closedPendingRef.current) return;
    closedPendingRef.current = false;
    const completed = completedRef.current;
    completedRef.current = false;
    window.dispatchEvent(
      new CustomEvent("policies:wizard-closed", { detail: { completed } }),
    );
  }, []);

  const closeAll = useCallback(() => {
    setWizardOpen(false);
    setWizardPolicies([]);
    setAwaitingPanelRows([]);
    // Safety net: dispatch even if we never opened the wizard. Covers
    // the "no filter matched" fallthrough in fetchAndRoute AND the
    // awaiting-review panel dismissal — both would otherwise hang the
    // api.ts caller forever.
    dispatchClosedIfPending();
  }, [dispatchClosedIfPending]);

  const handleWizardCompleted = useCallback(() => {
    completedRef.current = true;
    window.dispatchEvent(new CustomEvent("policies:signed"));
    // handleWizardClose runs on the trailing Dialog.Root close and
    // dispatches `policies:wizard-closed` with completed: true.
  }, []);

  const handleWizardClose = useCallback(() => {
    // dispatchClosedIfPending reads completedRef + resets both refs.
    dispatchClosedIfPending();
    closeAll();
  }, [closeAll, dispatchClosedIfPending]);

  const fetchAndRoute = useCallback(async (targetIds: string[] | null) => {
    if (loading) return;
    setLoading(true);
    try {
      const data = await apiGet<WorkerPoliciesResponse>("/api/me/policies");
      setDisplayName(data.displayName);
      const awaitingReview = data.awaitingReview ?? [];

      const requiredFiltered = targetIds && targetIds.length > 0
        ? data.required.filter((p) => targetIds.includes(p.policyId))
        : data.required;
      const awaitingFiltered = targetIds && targetIds.length > 0
        ? awaitingReview.filter((p) => targetIds.includes(p.policyId))
        : awaitingReview;

      if (requiredFiltered.length > 0) {
        setWizardPolicies(requiredFiltered);
        setAwaitingPanelRows([]);
        setWizardOpen(true);
        return;
      }
      if (awaitingFiltered.length > 0) {
        setWizardPolicies([]);
        setAwaitingPanelRows(awaitingFiltered);
        setWizardOpen(false);
        return;
      }
      if (data.required.length > 0) {
        setWizardPolicies(data.required);
        setAwaitingPanelRows([]);
        setWizardOpen(true);
        return;
      }
      closeAll();
    } catch {
      // Silently fail; the underlying API error was suppressed by the toast
      // filter, and retrying the action will re-fire the event.
    } finally {
      setLoading(false);
    }
  }, [loading, closeAll]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { pendingPolicyIds?: string[]; message?: string }
        | undefined;
      const ids = detail?.pendingPolicyIds ?? [];
      // Mark a wizard-closed dispatch as owed BEFORE fetching. Every
      // terminal path (wizard onClose, panel Close, stale-IDs
      // fallthrough) reads this flag and dispatches exactly once,
      // releasing the api.ts caller.
      closedPendingRef.current = true;
      void fetchAndRoute(ids.length > 0 ? ids : null);
    };
    window.addEventListener("policies:required", handler);
    return () => window.removeEventListener("policies:required", handler);
  }, [fetchAndRoute]);

  const panelOpen = awaitingPanelRows.length > 0;

  return (
    <>
      {wizardOpen && wizardPolicies.length > 0 && (
        <PolicySignWizard
          open={wizardOpen}
          policies={wizardPolicies}
          displayName={displayName}
          onClose={handleWizardClose}
          onCompleted={handleWizardCompleted}
        />
      )}
      <Dialog.Root
        role="alertdialog"
        open={panelOpen}
        onOpenChange={(e) => { if (!e.open) closeAll(); }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p={4}>
              <Dialog.Header>
                <Dialog.Title>Waiting on admin review</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm" mb={3}>
                  You've completed your part on {awaitingPanelRows.length === 1 ? "this policy" : "these policies"} —
                  an admin needs to review the upload before you can proceed with this action.
                </Text>
                <VStack align="stretch" gap={2}>
                  {awaitingPanelRows.map((row) => {
                    const uploadedLabel = row.uploadedAt ? fmtDate(row.uploadedAt) : null;
                    const expiresLabel = row.uploadExpiresAt ? fmtDate(row.uploadExpiresAt) : null;
                    return (
                      <HStack
                        key={row.policyId}
                        gap={2}
                        p={2}
                        borderRadius="md"
                        borderWidth="1px"
                        borderColor="blue.200"
                        bg="blue.50"
                        align="flex-start"
                      >
                        <Box color="blue.600" flexShrink={0} mt={0.5}>
                          <Clock size={14} />
                        </Box>
                        <VStack align="start" gap={0} flex="1" minW={0}>
                          <HStack gap={2} wrap="wrap">
                            <Text fontSize="sm" fontWeight="medium">
                              {row.title}
                            </Text>
                            <Badge size="xs" colorPalette="blue" variant="subtle">
                              Awaiting review
                            </Badge>
                          </HStack>
                          <Text fontSize="xs" color="fg.muted">
                            {row.uploadFileName ? `${row.uploadFileName}` : "Artifact uploaded"}
                            {uploadedLabel ? ` · uploaded ${uploadedLabel}` : ""}
                          </Text>
                          {expiresLabel && (
                            <Text fontSize="xs" color="fg.muted">
                              expires {expiresLabel}
                            </Text>
                          )}
                        </VStack>
                      </HStack>
                    );
                  })}
                </VStack>
                <Text fontSize="xs" color="fg.muted" mt={3}>
                  Need to swap out the uploaded file or cancel it? Go to your
                  <b> Profile → Compliance</b> section.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack gap={2} w="full" justify="flex-end">
                  <Button variant="ghost" onClick={closeAll}>Close</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
