"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Button, Card, HStack, Text, VStack } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import { apiGet } from "@/src/lib/api";

type WorkerPoliciesSummary = {
  displayName: string | null;
  required: Array<{
    policyId: string;
    title: string;
    enforcement: "BLOCK" | "WARN" | "INFO";
  }>;
};

/**
 * Prominent home-tab banner that surfaces pending compliance work for the
 * current worker. Placed above the workday strip and hero CTAs so it's the
 * first thing they see on landing.
 *
 * Renders only when there's something to nudge about:
 *   - Red banner + solid Sign now CTA when a BLOCK-level policy is pending
 *     (worker can't start work until they sign)
 *   - Orange banner + outline Sign now CTA when only WARN/INFO are pending
 *     (worker CAN work, but has recommended paperwork left)
 *
 * Silently absent when the worker is fully cleared or has no policies.
 *
 * Interaction: the Sign now button dispatches the same `policies:required`
 * event that the gate interceptor listens for, so PolicyGateInterceptor
 * opens the sign wizard with the current pending list. No new UI to build.
 *
 * Refresh: refetches on `policies:signed` so the banner disappears the
 * moment the last policy is signed (or the moment an admin grants an
 * exception, etc.). Also removes itself when the wizard closes with all
 * items handled.
 */
export default function ComplianceBanner({ disabled = false }: { disabled?: boolean }) {
  const [summary, setSummary] = useState<WorkerPoliciesSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<WorkerPoliciesSummary>("/api/me/policies");
      setSummary(data);
    } catch {
      // Silent failure — a fetch error shouldn't render an alarming red
      // banner. The alerts dropdown and profile compliance card are
      // separate signal paths that will still work.
      setSummary(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (disabled) return;
    void load();
    const onChanged = () => void load();
    window.addEventListener("policies:signed", onChanged);
    window.addEventListener("policies:changed", onChanged);
    return () => {
      window.removeEventListener("policies:signed", onChanged);
      window.removeEventListener("policies:changed", onChanged);
    };
  }, [disabled, load]);

  if (disabled || !loaded || !summary) return null;
  const required = summary.required;
  if (required.length === 0) return null;

  const blocking = required.filter((p) => p.enforcement === "BLOCK");
  const recommended = required.filter((p) => p.enforcement !== "BLOCK");
  const hasBlocking = blocking.length > 0;

  // Dispatch the same event the gate interceptor listens for. Passing no
  // pending ids tells the interceptor to show the full required list.
  const openWizard = () => {
    window.dispatchEvent(
      new CustomEvent("policies:required", {
        detail: { pendingPolicyIds: [], message: "Compliance banner" },
      }),
    );
  };

  // Alternate path for workers who'd rather see the full compliance
  // section (with per-policy status, history, etc.) instead of jumping
  // straight into the sign wizard. Dispatches the app-shell's profile
  // navigation event — the shell switches to the worker Profile tab
  // where the WorkerComplianceSection is rendered.
  const openProfile = () => {
    window.dispatchEvent(
      new CustomEvent("navigate:profile", { detail: {} }),
    );
  };

  const bg = hasBlocking ? "red.50" : "orange.50";
  const border = hasBlocking ? "red.300" : "orange.300";
  const iconColor = hasBlocking ? "red.600" : "orange.600";
  const buttonPalette: "red" | "orange" = hasBlocking ? "red" : "orange";

  const summaryText = (() => {
    if (hasBlocking && recommended.length === 0) {
      return blocking.length === 1
        ? "You have 1 required document to sign before you can start work."
        : `You have ${blocking.length} required documents to sign before you can start work.`;
    }
    if (hasBlocking && recommended.length > 0) {
      return `You have ${blocking.length} required + ${recommended.length} recommended document${blocking.length + recommended.length === 1 ? "" : "s"} to sign.`;
    }
    return recommended.length === 1
      ? "You have 1 recommended document to sign when you get a chance."
      : `You have ${recommended.length} recommended documents to sign when you get a chance.`;
  })();

  // Soft attention pulse — red when work is blocked, orange when only
  // recommended items remain. Same 2.5s cadence as the workday-strip pulses
  // so the visual language is consistent.
  const pulseAnimation = hasBlocking
    ? "seedlings-pulse-red 2.5s ease-in-out infinite"
    : "seedlings-pulse-orange 2.5s ease-in-out infinite";

  return (
    <Card.Root
      data-testid="compliance-banner"
      data-severity={hasBlocking ? "block" : "warn"}
      data-blocking-count={blocking.length}
      data-recommended-count={recommended.length}
      variant="outline"
      bg={bg}
      borderColor={border}
      borderWidth="1px"
      style={{ animation: pulseAnimation }}
    >
      <Card.Body p={3}>
        <HStack align="center" gap={3} wrap="wrap">
          <Box color={iconColor} flexShrink={0}>
            <AlertTriangle size={20} />
          </Box>
          <VStack align="start" gap={0} flex={1} minW={0}>
            <Text fontSize="sm" fontWeight="semibold">
              Compliance
            </Text>
            <Text fontSize="xs" color="fg.muted" lineClamp={2}>
              {summaryText}
            </Text>
          </VStack>
          <HStack gap={2} flexShrink={0}>
            <Button size="sm" variant="outline" colorPalette={buttonPalette} onClick={openProfile}>
              View profile
            </Button>
            <Button size="sm" colorPalette={buttonPalette} onClick={openWizard}>
              Sign now
            </Button>
          </HStack>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}
