"use client";

// Inline section for the Tasks page — lists every pending sign-up
// (User.isApproved = false) with the two most-common actions:
//   • Approve as Client → opens ApproveAndLinkClientDialog so the
//     operator can pick a ClientContact to bind to in one step.
//   • Decline → typed-confirm dialog → DELETE /admin/users/:id.
//
// "Approve as Worker" is intentionally NOT inline. That path requires
// a typed-email confirmation + role-grant + worker-type decision; it's
// rare enough that the Goto Task button on the Tasks page (which
// jumps to Super → Users) handles it. Keeping the inline scope narrow
// keeps this component small and reusable.

import { useCallback, useEffect, useState } from "react";
import { Badge, Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { CheckCircle2, X } from "lucide-react";
import { apiDelete, apiGet } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ApproveAndLinkClientDialog from "@/src/ui/dialogs/ApproveAndLinkClientDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type PendingUser = {
  id: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
};

function userLabel(u: PendingUser): string {
  return u.displayName || u.email || u.id.slice(-8);
}

export default function PendingUserSignupsSection() {
  const [items, setItems] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [approveTarget, setApproveTarget] = useState<PendingUser | null>(null);
  const [declineTarget, setDeclineTarget] = useState<PendingUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<PendingUser[]>("/api/admin/users?approved=false");
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load pending sign-ups.", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("seedlings3:users-changed", onChanged);
    return () => window.removeEventListener("seedlings3:users-changed", onChanged);
  }, [load]);

  async function performDecline(u: PendingUser) {
    setBusyId(u.id);
    try {
      await apiDelete(`/api/admin/users/${u.id}`);
      window.dispatchEvent(new Event("seedlings3:users-changed"));
      publishInlineMessage({ type: "SUCCESS", text: `Declined ${userLabel(u)}.` });
      setDeclineTarget(null);
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Decline failed.", err) });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && items.length === 0) {
    return (
      <HStack py={3} justify="center" color="fg.muted">
        <Spinner size="sm" />
        <Text fontSize="sm">Loading…</Text>
      </HStack>
    );
  }
  if (items.length === 0) return null;

  return (
    <>
      <VStack align="stretch" gap={2}>
        {items.map((u) => (
          <Box
            key={u.id}
            p={2}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
          >
            <HStack justify="space-between" align="start" gap={2} wrap="wrap">
              <VStack align="start" gap={0} flex={1} minW={0}>
                <HStack gap={2}>
                  <Text fontSize="sm" fontWeight="medium">{userLabel(u)}</Text>
                  {u.email && u.displayName && (
                    <Badge size="xs" variant="subtle">{u.email}</Badge>
                  )}
                </HStack>
                <Text fontSize="2xs" color="fg.muted">
                  Signed up {fmtDate(u.createdAt)}
                </Text>
              </VStack>
              <HStack gap={1} flexShrink={0}>
                <Button
                  size="xs"
                  colorPalette="green"
                  disabled={busyId !== null}
                  onClick={() => setApproveTarget(u)}
                >
                  <CheckCircle2 size={12} /> Approve as Client
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  colorPalette="red"
                  disabled={busyId !== null}
                  onClick={() => setDeclineTarget(u)}
                >
                  <X size={12} /> Decline
                </Button>
              </HStack>
            </HStack>
          </Box>
        ))}
      </VStack>

      {approveTarget && (
        <ApproveAndLinkClientDialog
          open={!!approveTarget}
          user={{
            id: approveTarget.id,
            displayName: approveTarget.displayName,
            email: approveTarget.email,
          }}
          onClose={() => setApproveTarget(null)}
          onApproved={() => {
            setApproveTarget(null);
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!declineTarget}
        title="Decline this sign-up?"
        message={
          declineTarget
            ? `Declining ${userLabel(declineTarget)} removes their account from the database AND their Clerk identity. This cannot be undone.`
            : ""
        }
        confirmLabel={busyId ? "Declining…" : "Decline"}
        confirmColorPalette="red"
        onConfirm={() => {
          if (declineTarget && busyId === null) void performDecline(declineTarget);
        }}
        onCancel={() => setDeclineTarget(null)}
      />
    </>
  );
}
