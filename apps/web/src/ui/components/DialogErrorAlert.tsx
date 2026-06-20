"use client";

import { useState } from "react";
import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import { getErrorMessage } from "@/src/ui/components/InlineMessage";

// ─────────────────────────────────────────────────────────────────────────
// DialogErrorAlert — inline error strip for dialogs.
//
// Why this exists: a centered/large dialog on a small device covers up
// the bottom-anchored toast, so a `publishInlineMessage({type:"ERROR"})`
// raised by the dialog's confirm action is invisible to the user — they
// see a no-op and assume the click didn't register. The fix is to render
// errors inside the dialog itself, just above the footer.
//
// Convention across the app:
//   • SUCCESS / INFO toasts stay as toasts — the dialog is gone by then.
//   • ERROR from the dialog's own confirm action → renders inline here.
//
// Use either the bare <DialogErrorAlert /> component or the convenience
// `useDialogError()` hook which packages state + a wrapping `run()` helper.
// ─────────────────────────────────────────────────────────────────────────

export function DialogErrorAlert({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <Box
      mt={2}
      mb={1}
      p={2}
      bg="red.50"
      borderWidth="1px"
      borderColor="red.300"
      borderRadius="md"
      role="alert"
    >
      <HStack gap={2} align="start">
        <Box color="red.600" flexShrink={0} mt="2px">
          <AlertTriangle size={14} />
        </Box>
        <Text fontSize="sm" color="red.900" flex="1">
          {error}
        </Text>
        {onDismiss && (
          <Button
            size="xs"
            variant="ghost"
            colorPalette="red"
            onClick={onDismiss}
            px={2}
            minW="auto"
          >
            ×
          </Button>
        )}
      </HStack>
    </Box>
  );
}

/**
 * Convenience hook for dialogs.
 *
 *   const dlgErr = useDialogError();
 *   ...
 *   async function save() {
 *     await dlgErr.run("Save failed.", async () => {
 *       await api.save(...);
 *       onClose();
 *     });
 *   }
 *   ...
 *   <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
 *
 * `run` clears any prior error, executes the body, and on throw stashes
 * the message. Returns true on success, false on caught error. The caller
 * can branch on that if needed (e.g. close dialog only on success), but
 * most callers just `onClose()` inside the body and skip it on error.
 */
export function useDialogError() {
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    setError,
    clear: () => setError(null),
    async run(fallback: string, fn: () => Promise<void>): Promise<boolean> {
      setError(null);
      try {
        await fn();
        return true;
      } catch (err) {
        setError(getErrorMessage(fallback, err));
        return false;
      }
    },
  };
}
