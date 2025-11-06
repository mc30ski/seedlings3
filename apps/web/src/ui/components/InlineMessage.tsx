"use client";

import React, { useEffect, useRef, useState } from "react";
import { Box, HStack, Text, Icon, CloseButton, Portal } from "@chakra-ui/react";
import { CheckCircle2, Info, AlertTriangle, OctagonAlert } from "lucide-react";

export const MESSAGE_KIND = ["SUCCESS", "WARNING", "INFO", "ERROR"] as const;

export type MessageKind = (typeof MESSAGE_KIND)[number];

export type InlineMessageEventDetail = {
  /** Optional scope. When omitted, only InlineMessage without a scope will show it. */
  scope?: string;
  type: MessageKind;
  text: string;
  /** Auto-hide after N ms (optional). */
  autoHideMs?: number;
  /** Optional fade animation duration (ms) when hiding (auto or manual). Defaults to 180ms. */
  fadeOutMs?: number;
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

type MsgState = { type: MessageKind; text: string; fadeOutMs?: number } | null;

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
  const [isVisible, setIsVisible] = useState(false); // controls fade in/out
  const autoTimerRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<number | null>(null);

  // helper: clear any timers
  const clearTimers = () => {
    if (autoTimerRef.current) {
      window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    if (fadeTimerRef.current) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  };

  // helper: begin fade-out then clear the message after fade duration
  const beginHide = (fadeOutMs = 180) => {
    setIsVisible(false); // triggers CSS transition
    if (fadeTimerRef.current) window.clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = window.setTimeout(() => {
      setMsg(null);
      fadeTimerRef.current = null;
    }, fadeOutMs);
  };

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
      clearTimers();
      setMsg({ type: det.type, text: det.text, fadeOutMs: det.fadeOutMs });
      // show (fade-in)
      setIsVisible(true);

      if (det.autoHideMs === undefined && det.type === "SUCCESS") {
        det.autoHideMs = 5000; // Default
      }

      // arm auto-hide (starts fade, then clears after fadeOutMs)
      if (det.autoHideMs && det.autoHideMs > 0) {
        autoTimerRef.current = window.setTimeout(() => {
          beginHide(det.fadeOutMs ?? 180);
          autoTimerRef.current = null;
        }, det.autoHideMs);
      }
    };

    window.addEventListener(EVENT_NAME, handler as EventListener);
    return () => {
      window.removeEventListener(EVENT_NAME, handler as EventListener);
      clearTimers();
    };
  }, [scope]);

  if (!msg && hiddenUntilMessage) return null;

  const palette = getPalette(msg?.type ?? "INFO");
  const dismissible = msg ? dismissibleTypes.includes(msg.type) : false;

  // read fade duration from current message or default
  const fadeOutMs = msg?.fadeOutMs ?? 180;

  return (
    <Portal>
      {/* Overlay container (doesn't take layout space) */}
      <Box
        position="fixed"
        left={0}
        right={0}
        bottom="16px"
        display="flex"
        justifyContent="center"
        pointerEvents="none"
        zIndex={1000}
      >
        {/* Holder width: ~80% viewport, capped; tweak as you like */}
        <Box
          pointerEvents="auto"
          w="80vw"
          maxW="800px"
          mx="4"
          // fade/slide in & out
          transition={`transform ${fadeOutMs}ms ease, opacity ${fadeOutMs}ms ease`}
          transform={isVisible ? "translateY(0)" : "translateY(8px)"}
          opacity={isVisible ? 1 : 0}
        >
          <Box
            role={
              msg?.type === "ERROR" || msg?.type === "WARNING"
                ? "alert"
                : "status"
            }
            aria-live="polite"
            borderWidth="1px"
            borderRadius="md"
            px={3}
            py={2}
            bg={palette.bg}
            borderColor={palette.border}
            color={palette.fg}
            boxShadow="md"
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
                  onClick={() => beginHide(fadeOutMs)}
                />
              )}
            </HStack>
          </Box>
        </Box>
      </Box>
    </Portal>
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
        bg: "red.100",
        border: "red.400",
        fg: "red.900",
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
  if (detail.type === "WARNING" || detail.type === "ERROR") {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
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
