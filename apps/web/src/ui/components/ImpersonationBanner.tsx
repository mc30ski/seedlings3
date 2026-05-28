"use client";

import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import type { Me } from "@/src/lib/types";
import {
  getImpersonation,
  IMPERSONATION_LABELS,
  setImpersonation,
} from "@/src/lib/impersonation";

// Persistent red banner that renders on every page when a Super has the
// View-as-another-role override active. The banner is the always-available
// exit affordance — even if the impersonated UI hides the Profile tab or
// the View-as picker, Super can always tap "Exit" here.
//
// Renders nothing when the override isn't active OR when the caller isn't a
// real Super (e.g. a non-Super browser with a manually-set localStorage
// value would never get isImpersonating from the server, so we suppress).

type Props = { me: Me | null };

export default function ImpersonationBanner({ me }: Props) {
  const value = getImpersonation();
  const isReallySuper = !!me?.realRoles?.includes("SUPER");
  // Belt-and-suspenders: render only when BOTH client-side state and the
  // server-confirmed flag agree the user is impersonating. Prevents the
  // banner from flashing on a brand-new tab before /me has come back.
  if (!value || !isReallySuper || !me?.isImpersonating) return null;
  const label = IMPERSONATION_LABELS[value] ?? value;
  return (
    <Box
      bg="red.600"
      color="white"
      px={3}
      py={2}
      position="sticky"
      top={0}
      zIndex={1000}
      borderBottomWidth="2px"
      borderColor="red.700"
      shadow="md"
    >
      <HStack justify="space-between" gap={3} wrap="wrap">
        <HStack gap={2} minW={0}>
          <AlertTriangle size={18} />
          <Text fontSize="sm" fontWeight="semibold">
            Impersonating: {label}
          </Text>
          <Text fontSize="xs" color="red.100" display={{ base: "none", md: "block" }}>
            Your UI and backend authorization are reduced. Mutations are still real.
          </Text>
        </HStack>
        <Button
          size="xs"
          variant="solid"
          colorPalette="red"
          bg="white"
          color="red.700"
          _hover={{ bg: "red.50" }}
          onClick={() => void setImpersonation(null)}
        >
          Exit impersonation
        </Button>
      </HStack>
    </Box>
  );
}
