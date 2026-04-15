"use client";

import { useEffect, useState } from "react";
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
import { RefreshCw, Trash2 } from "lucide-react";
import {
  type QueuedAction,
  getAllActions,
  deleteAction,
  retryAction,
  clearAllActions,
  subscribeQueue,
} from "@/src/lib/offlineQueue";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pending: { text: "Pending", color: "gray.500" },
  syncing: { text: "Syncing...", color: "blue.500" },
  synced: { text: "Synced", color: "green.500" },
  failed: { text: "Failed", color: "red.500" },
};

const STATUS_ICON: Record<string, string> = {
  pending: "⏳",
  syncing: "🔄",
  synced: "✅",
  failed: "❌",
};

const ACTION_LABEL: Record<string, { text: string; color: string }> = {
  START_JOB: { text: "Start", color: "green" },
  COMPLETE_JOB: { text: "Complete", color: "blue" },
  ADD_PHOTO: { text: "Photo", color: "purple" },
  ADD_EXPENSE: { text: "Expense", color: "orange" },
  POST_COMMENT: { text: "Comment", color: "cyan" },
  SET_REMINDER: { text: "Reminder", color: "yellow" },
  CLEAR_REMINDER: { text: "Clear Reminder", color: "gray" },
  PIN: { text: "Pin", color: "teal" },
  UNPIN: { text: "Unpin", color: "gray" },
  LIKE: { text: "Like", color: "red" },
  UNLIKE: { text: "Unlike", color: "gray" },
  DISMISS_REMINDER: { text: "Dismiss", color: "gray" },
};

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function OfflineQueueDialog({ open, onOpenChange }: Props) {
  const [actions, setActions] = useState<QueuedAction[]>([]);

  useEffect(() => {
    if (!open) return;
    void getAllActions().then(setActions);
    return subscribeQueue(() => void getAllActions().then(setActions));
  }, [open]);

  // Group by occurrenceId
  const grouped = new Map<string, QueuedAction[]>();
  for (const a of actions) {
    const key = a.occurrenceId || "__general__";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  }

  const pendingOrFailed = actions.filter((a) => a.status === "pending" || a.status === "failed");

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <HStack justify="space-between" align="center" w="full">
                <Dialog.Title>Offline Queue</Dialog.Title>
                {pendingOrFailed.length > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    colorPalette="red"
                    onClick={async () => {
                      await clearAllActions();
                      void getAllActions().then(setActions);
                    }}
                  >
                    Clear All
                  </Button>
                )}
              </HStack>
            </Dialog.Header>
            <Dialog.Body style={{ maxHeight: "60vh", overflowY: "auto" }}>
              {actions.length === 0 ? (
                <Text fontSize="sm" color="fg.muted" py={4} textAlign="center">
                  No queued actions. Actions performed while offline will appear here.
                </Text>
              ) : (
                <VStack align="stretch" gap={3}>
                  {[...grouped.entries()].map(([occId, group]) => (
                    <Box key={occId}>
                      <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                        {group[0]?.label?.split(" · ")[0] ?? occId}
                      </Text>
                      <VStack align="stretch" gap={1}>
                        {group.map((a) => (
                          <Box
                            key={a.id}
                            p={2}
                            borderWidth="1px"
                            borderRadius="md"
                            borderColor={a.status === "failed" ? "red.200" : a.status === "synced" ? "green.200" : "gray.200"}
                            bg={a.status === "failed" ? "red.50" : a.status === "synced" ? "green.50" : undefined}
                          >
                            <HStack justify="space-between" align="start">
                              <VStack align="start" gap={0.5} flex="1" minW={0}>
                                <HStack gap={1.5} flexWrap="wrap">
                                  <Text fontSize="xs">{STATUS_ICON[a.status] ?? "⏳"}</Text>
                                  <Badge size="sm" variant="subtle" colorPalette={ACTION_LABEL[a.type]?.color ?? "gray"}>
                                    {ACTION_LABEL[a.type]?.text ?? a.type}
                                  </Badge>
                                  <Text fontSize="xs" fontWeight="medium" lineClamp={2}>{a.label}</Text>
                                </HStack>
                                <HStack gap={2} fontSize="xs" color="fg.muted">
                                  <Text>{timeAgo(a.createdAt)}</Text>
                                  <Text color={STATUS_LABEL[a.status]?.color}>
                                    {STATUS_LABEL[a.status]?.text}
                                  </Text>
                                  {a.retries > 0 && a.status === "failed" && (
                                    <Text>({a.retries} retries)</Text>
                                  )}
                                </HStack>
                                {a.error && (
                                  <Text fontSize="xs" color="red.600" mt={0.5}>{a.error}</Text>
                                )}
                              </VStack>
                              <HStack gap={1} flexShrink={0}>
                                {a.status === "failed" && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    px="1"
                                    minW="0"
                                    title="Retry"
                                    onClick={async () => {
                                      await retryAction(a.id);
                                      void getAllActions().then(setActions);
                                    }}
                                  >
                                    <RefreshCw size={12} />
                                  </Button>
                                )}
                                {(a.status === "pending" || a.status === "failed") && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="red"
                                    px="1"
                                    minW="0"
                                    title="Delete"
                                    onClick={async () => {
                                      await deleteAction(a.id);
                                      void getAllActions().then(setActions);
                                    }}
                                  >
                                    <Trash2 size={12} />
                                  </Button>
                                )}
                              </HStack>
                            </HStack>
                          </Box>
                        ))}
                      </VStack>
                    </Box>
                  ))}
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger />
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
