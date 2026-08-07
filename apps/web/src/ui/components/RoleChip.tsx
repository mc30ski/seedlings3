"use client";

// Header-mounted role switcher — replaces the outer "Client/Worker/Admin/Super"
// tab pill in BreadcrumbNav. Sits next to the profile avatar so role is an
// identity context, not a primary navigation axis.
//
// Renders NOTHING when the user has zero or one role — nothing to switch to.
// For multi-role users, shows the current role as a small chip; clicking
// opens a dropdown of the roles they have.
//
// The parent handles the actual switch (via onSwitch) so it can preserve
// the current inner tab across roles (same-tab preservation).

import { useEffect, useRef, useState } from "react";
import { Box, HStack, Icon, Text } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";

export type RoleValue = "client" | "worker" | "admin" | "super";

export type RoleOption = {
  value: RoleValue;
  label: string;
  icon?: React.ElementType;
};

type Props = {
  activeRole: RoleValue;
  availableRoles: RoleOption[];
  onSwitch: (role: RoleValue) => void;
};

export default function RoleChip({ activeRole, availableRoles, onSwitch }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (availableRoles.length < 2) return null;
  const active = availableRoles.find((r) => r.value === activeRole) ?? availableRoles[0];

  return (
    <Box position="relative" ref={ref} flexShrink={0}>
      {/* Solid dark-green chip — matches the darker tones of the leaf
          logo, giving the header a cohesive "brand green" identity
          without blending into the header's soft-green gradient (the
          chip is several shades darker). Distinct from every other
          header pill (blue inner tabs, teal categories, purple queue,
          amber on-clock, red alerts). Reads as an "identity / acting
          as" marker at a glance. */}
      <HStack
        as="button"
        gap={1}
        px={2.5}
        py={1}
        rounded="full"
        bg={open ? "green.700" : "green.600"}
        color="white"
        _hover={{ bg: "green.700" }}
        shadow="sm"
        cursor="pointer"
        onClick={() => setOpen((v) => !v)}
        transition="all 0.1s"
        aria-label={`Acting as ${active.label} — click to switch role`}
        title={`Acting as ${active.label}`}
      >
        {active.icon && <Icon as={active.icon} boxSize={3.5} />}
        <Text fontSize="sm" fontWeight="semibold" lineHeight="1">
          {active.label}
        </Text>
        <ChevronDown size={13} />
      </HStack>
      {open && (
        <Box
          position="absolute"
          zIndex={1000}
          right={0}
          top="100%"
          mt={1}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          rounded="lg"
          shadow="lg"
          minW="160px"
          py={1}
        >
          <Box px={3} py={1.5}>
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
              Acting as
            </Text>
          </Box>
          {availableRoles.map((r) => (
            <HStack
              key={r.value}
              as="button"
              w="full"
              px={3}
              py={2}
              gap={2}
              cursor="pointer"
              bg={r.value === activeRole ? "blue.50" : undefined}
              _hover={{ bg: r.value === activeRole ? "blue.100" : "gray.50" }}
              onClick={() => {
                setOpen(false);
                if (r.value !== activeRole) onSwitch(r.value);
              }}
            >
              {r.icon && (
                <Icon
                  as={r.icon}
                  boxSize={4}
                  color={r.value === activeRole ? "blue.600" : "fg.muted"}
                />
              )}
              <Text
                fontSize="sm"
                fontWeight={r.value === activeRole ? "semibold" : "normal"}
                color={r.value === activeRole ? "blue.700" : undefined}
              >
                {r.label}
              </Text>
            </HStack>
          ))}
        </Box>
      )}
    </Box>
  );
}
