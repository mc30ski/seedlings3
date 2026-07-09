"use client";

import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { AlertTriangle, Eye } from "lucide-react";
import type { Me } from "@/src/lib/types";
import {
  getClientImpersonation,
  getImpersonation,
  IMPERSONATION_LABELS,
  setClientImpersonation,
  setImpersonation,
} from "@/src/lib/impersonation";

// Persistent red banner that renders on every page when a Super has any
// impersonation override active. Two orthogonal flavors:
//
//  1. Role impersonation — "View as if my role were X". Server-confirmed
//     via me.isImpersonating. Warning: mutations are still real.
//  2. Client impersonation — "View as this client account". Purely
//     client-side + header-driven; the server enforces read-only.
//
// Both are always-available exit affordances even if the impersonated UI
// hides the source affordance (Profile tab, admin Clients tab, etc.).
//
// If both are active (unusual), the client banner takes precedence — it's
// the more constrained mode and its read-only rule is the more important
// signal to surface.

type Props = { me: Me | null };

export default function ImpersonationBanner({ me }: Props) {
  const isReallySuper = !!me?.realRoles?.includes("SUPER");
  if (!isReallySuper) return null;

  const clientImp = getClientImpersonation();
  if (clientImp) {
    return (
      <Box
        bg="purple.700"
        color="white"
        px={3}
        py={2}
        position="sticky"
        top={0}
        zIndex={1000}
        borderBottomWidth="2px"
        borderColor="purple.800"
        shadow="md"
      >
        <HStack justify="space-between" gap={3} wrap="wrap">
          <HStack gap={2} minW={0}>
            <Eye size={18} />
            <Text fontSize="sm" fontWeight="semibold">
              Read-only preview: viewing as {clientImp.contactName} on behalf of {clientImp.clientName}
            </Text>
            <Text fontSize="xs" color="purple.100" display={{ base: "none", md: "block" }}>
              You see what this client sees. All writes are refused server-side.
            </Text>
          </HStack>
          <Button
            size="xs"
            variant="solid"
            bg="white"
            color="purple.700"
            _hover={{ bg: "purple.50" }}
            onClick={() => void setClientImpersonation(null)}
          >
            Exit view-as
          </Button>
        </HStack>
      </Box>
    );
  }

  const value = getImpersonation();
  // Belt-and-suspenders: render only when BOTH client-side state and the
  // server-confirmed flag agree the user is impersonating. Prevents the
  // banner from flashing on a brand-new tab before /me has come back.
  if (!value || !me?.isImpersonating) return null;
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
