"use client";

import React, { useEffect, useRef, useState } from "react";
import { Box, HStack, Text, Icon, CloseButton } from "@chakra-ui/react";
import { CheckCircle2, Info, AlertTriangle, OctagonAlert } from "lucide-react";

export const MESSAGE_KIND = ["SUCCESS", "WARNING", "INFO", "ERROR"] as const;

export type MessageKind = (typeof MESSAGE_KIND)[number];

export type InlineMessageEventDetail = {
  /** Optional scope. When omitted, only InlineMessage without a scope will show it. */
  scope?: string;
  type: MessageKind;
  text: string;
  /** Auto-hide after N ms (optional). If omitted, stays until replaced or dismissed. */
  autoHideMs?: number;
};

type Props = {
  /** Optional scope. When omitted, only InlineMessage without a scope will show it. */
  scope?: string;
  /** Which message types can be dismissed by the user */
  dismissibleTypes?: MessageKind[]; // default: all
  /** Start hidden until an event arrives (default true) */
  hiddenUntilMessage?: boolean; // default: true
  /** Optional className or style */
  className?: string;
  style?: React.CSSProperties;
};

type MsgState = { type: MessageKind; text: string } | null;

// Publisher API (re-export below for convenience)
const EVENT_NAME = "seedlings3:inline-message";

export default function InlineMessage({
  scope,
  dismissibleTypes = ["SUCCESS", "WARNING", "INFO", "ERROR"],
  hiddenUntilMessage = true,
  className,
  style,
}: Props) {
  const [msg, setMsg] = useState<MsgState>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const det = (e as CustomEvent<InlineMessageEventDetail>).detail;
      if (!det) return;

      const compScope = scope ?? undefined; // undefined when not provided
      const eventScope = det.scope ?? undefined;

      // Matching rules:
      // - If both scopes are defined, require equality.
      // - If both scopes are undefined, match (default/global).
      // - Otherwise, ignore.
      const matches =
        (compScope === undefined && eventScope === undefined) ||
        (compScope !== undefined && compScope === eventScope);

      if (!matches) return;

      // replace current message
      setMsg({ type: det.type, text: det.text });

      // reset/arm auto-hide
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (det.autoHideMs && det.autoHideMs > 0) {
        timerRef.current = window.setTimeout(() => {
          setMsg(null);
          timerRef.current = null;
        }, det.autoHideMs);
      }
    };

    window.addEventListener(EVENT_NAME, handler as EventListener);
    return () => {
      window.removeEventListener(EVENT_NAME, handler as EventListener);
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [scope]);

  if (!msg && hiddenUntilMessage) return null;

  const palette = getPalette(msg?.type ?? "INFO");
  const dismissible = msg ? dismissibleTypes.includes(msg.type) : false;

  return (
    <Box
      role={
        msg?.type === "ERROR" || msg?.type === "WARNING" ? "alert" : "status"
      }
      aria-live="polite"
      borderWidth="1px"
      borderRadius="md"
      px={3}
      py={2}
      mb={3}
      bg={palette.bg}
      borderColor={palette.border}
      color={palette.fg}
      className={className}
      style={style}
    >
      <HStack justify="space-between" align="center" gap="2" minH="36px">
        <HStack align="start" gap="2" minW={0}>
          <Icon as={palette.icon} boxSize={4} mt="1px" />
          <Text fontSize="sm" fontWeight="medium" lineClamp={4}>
            {msg?.text ?? ""}
          </Text>
        </HStack>
        {dismissible && (
          <CloseButton
            size="sm"
            aria-label="Dismiss"
            onClick={() => setMsg(null)}
          />
        )}
      </HStack>
    </Box>
  );
}

function getPalette(kind: MessageKind) {
  switch (kind) {
    case "SUCCESS":
      return {
        bg: "green.50",
        border: "green.200",
        fg: "green.800",
        icon: CheckCircle2,
      };
    case "WARNING":
      return {
        bg: "orange.50",
        border: "orange.200",
        fg: "orange.900",
        icon: AlertTriangle,
      };
    case "ERROR":
      return {
        bg: "red.50",
        border: "red.200",
        fg: "red.800",
        icon: OctagonAlert,
      };
    case "INFO":
    default:
      return {
        bg: "blue.50",
        border: "blue.200",
        fg: "blue.800",
        icon: Info,
      };
  }
}

/** Publish a message to InlineMessage.
 * If you omit `scope`, only components without a scope will show it.
 */
export function publishInlineMessage(detail: InlineMessageEventDetail) {
  window.dispatchEvent(
    new CustomEvent<InlineMessageEventDetail>(EVENT_NAME, { detail })
  );
}

export function getErrorMessage(message: string, err: unknown): string {
  const anyErr = err as any;
  let msg = message + ". ";

  if (anyErr?.status === 401 || anyErr?.status === 403) {
    msg += "Not authorized or not approved.";
  }
  msg +=
    typeof anyErr?.message === "string" ? anyErr.message : "Unexpected error";
  return msg;
}
