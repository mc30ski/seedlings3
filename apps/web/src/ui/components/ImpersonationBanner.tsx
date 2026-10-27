"use client";

import { useEffect, useState } from "react";
import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { Eye } from "lucide-react";
import type { Me } from "@/src/lib/types";
import {
  getClientImpersonation,
  type ClientImpersonationValue,
  perspectiveLabel,
  setClientImpersonation,
  setPerspective,
} from "@/src/lib/impersonation";

// Persistent red banner that renders on every page when someone with `settings.manage` has any
// impersonation override active. Two orthogonal flavors:
//
//  1. Perspective — "show me only what this narrower role allows".
//     Server-confirmed via me.activePerspectiveRoleId. Mutations are real.
//  2. Client impersonation — "View as this client account". Purely
//     client-side + header-driven; the server enforces read-only.
//
// Both are always-available exit affordances even if the impersonated UI
// hides the source affordance (Profile tab, admin Clients tab, etc.).
//
// If both are active (unusual), the client banner takes precedence — it's
// the more constrained mode and its read-only rule is the more important
// signal to surface.

type Props = {
  me: Me | null;
  /** True while a staff account is looking at the customer-facing shell. */
  inClientShell?: boolean;
};

/**
 * One bar, three states, and NONE OF THEM RED.
 *
 * Red is the colour this app uses for alerts and for money that has gone
 * wrong. Every one of these is a statement about which view you are in —
 * normal, deliberate, and in the case of "My Roles" the state you are in
 * nearly all the time. A permanent red bar teaches people to stop reading
 * bars.
 *
 * Ink is `{palette}.contrast`, never a ramp value: `solid` is a fill and
 * the ramp does not follow a theme. The secondary line is the same ink at
 * reduced opacity rather than `{palette}.100`, which is the shape that
 * goes unreadable on the dark-grounded themes.
 */
function ViewBar({
  palette,
  icon,
  title,
  detail,
  action,
}: {
  palette: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <Box
      bg={`${palette}.solid`}
      color={`${palette}.contrast`}
      px={3}
      py={2}
      position="sticky"
      top={0}
      zIndex={1000}
      borderBottomWidth="2px"
      borderColor={`${palette}.emphasized`}
      shadow="md"
    >
      {/* A FLOOR, so the three bars are the same height. Two of them carry
          an action button and one does not, and a 32px button made those
          rows 8px taller than the text-only one — so switching views
          nudged the whole page up or down. */}
      <HStack justify="space-between" gap={3} wrap="wrap" minH="32px" align="center">
        <HStack gap={2} minW={0}>
          {icon}
          <Text fontSize="md" fontWeight="semibold">
            {title}
          </Text>
          <Text fontSize="sm" opacity={0.9} display={{ base: "none", md: "block" }}>
            {detail}
          </Text>
        </HStack>
        {action && (
          <Button
            size="xs"
            variant="solid"
            bg="bg.panel"
            color={`${palette}.fg`}
            _hover={{ bg: `${palette}.faint` }}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        )}
      </HStack>
    </Box>
  );
}

export default function ImpersonationBanner({ me, inClientShell }: Props) {
  // The client banner is checked FIRST and is not gated on perspectives.
  // `/api/me` answers with no capabilities and no perspectives inside a
  // client "View as" session, so gating this on `canSwitchLens` hid the
  // banner exactly when it was running — no notice that the session was
  // live, and no way out of it but clearing localStorage by hand.
  //
  // Read AFTER mount. The session lives in localStorage, which the server
  // cannot see, so reading it during render made the first client paint
  // disagree with the SSR output: React threw the whole tree away
  // ("Hydration failed… the entire root will switch to client
  // rendering") and, in dev, the Next overlay sat over the page.
  const [clientImp, setClientImp] = useState<ClientImpersonationValue | null>(null);
  useEffect(() => {
    setClientImp(getClientImpersonation());
  }, []);

  // This was a role check: the banner had to know the caller's
  // UNDERLYING role, because the role swap had already overwritten the
  // visible one. A perspective does not overwrite anything — `perspectives`
  // is the full list the person may reach either way — so the honest test is
  // simply "is there a perspective to leave?".
  const canSwitchLens = (me?.perspectives?.length ?? 0) > 0;
  if (!clientImp && !canSwitchLens) return null;
  if (clientImp) {
    return (
      <ViewBar
        palette="purple"
        icon={<Eye size={18} />}
        // "READ-ONLY PREVIEW" IS NOT DECORATION — restore it before touching
        // this string again. Rewriting this bar around the shared ViewBar,
        // I shortened it to "Viewing as <name>" and dropped those words,
        // which are the single most important fact about a view-as session:
        // it cannot change the customer's data. Three specs assert this
        // exact phrase, and they were right to.
        // BOTH NAMES IN ONE SENTENCE, as it was before this bar was folded
        // into the shared ViewBar. Splitting them put the contact in the
        // title and the client in the detail, which reads fine and breaks
        // the thing that matters: "who am I, and on whose account" is one
        // question, and an operator checking they are in the right session
        // should not have to assemble the answer from two lines.
        title={`Read-only preview: viewing as ${clientImp.contactName} on behalf of ${clientImp.clientName}`}
        detail="You see what this customer sees, and nothing you do here can change their data."
        action={{ label: "Exit view-as", onClick: () => void setClientImpersonation(null) }}
      />
    );
  }

  // The SERVER decides which perspective is active, not localStorage. A
  // roleId the caller cannot reach is ignored silently by
  // `resolvePerspective`, so trusting the stored value here would announce
  // a state that is not in force.
  const activeRoleId = me?.activePerspectiveRoleId ?? null;

  // Staff standing in the customer-facing shell. More specific than "My
  // access", so it wins — and unlike a perspective this one needs a way
  // out, because that shell has no role chip of its own.
  if (inClientShell) {
    return (
      <ViewBar
        palette="teal"
        icon={<Eye size={18} />}
        title="Client"
        detail="Viewing customer-facing pages, as a client sees them."
        // NO BUTTON. The way back is the chip's dropdown, which is where
        // every other view change is made — a second affordance for the
        // same thing just means two places to keep in step.
      />
    );
  }

  // NO BAR IN FULL ACCESS. There used to be a blue "My Roles" one here, on
  // the reasoning below — that a whole-page cue beats a chip for a state
  // that persists. In practice it was a permanent band across every screen
  // telling you that you are yourself, which is the common case and not
  // news. The chip in the title bar already names the lens when one is on.
  //
  // So all three states now read: no bar normally, the teal bar while a
  // staff account stands in the customer shell, and the purple one while a
  // client view-as session is live. Only the two unusual states speak.
  return null;
}
