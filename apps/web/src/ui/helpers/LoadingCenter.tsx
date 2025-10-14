"use client";

import React from "react";
import { Box, Spinner, Portal } from "@chakra-ui/react";

type LoadingCenterProps = {
  /** Show a dim backdrop behind the spinner (blocks clicks) */
  backdrop?: boolean; // default: true
  /** Custom z-index (higher = more on top) */
  zIndex?: number; // default: 10000
  /** Pass 'none' to allow clicks to pass through the overlay */
  pointerEvents?: "auto" | "none"; // default: "auto"
  /** Optional text next to the spinner */
  label?: React.ReactNode;
};

export default function LoadingCenter({
  backdrop = false,
  zIndex = 10000,
  pointerEvents = "auto",
  label,
}: LoadingCenterProps) {
  return (
    <Portal>
      <Box
        position="fixed"
        inset="0"
        zIndex={zIndex}
        display="flex"
        alignItems="center"
        justifyContent="center"
        pointerEvents={pointerEvents}
      >
        {/* Optional backdrop */}
        {backdrop && (
          <Box
            position="absolute"
            inset="0"
            bg="blackAlpha.300"
            backdropFilter="saturate(120%) blur(2px)"
          />
        )}

        {/* Spinner + optional label */}
        <Box
          position="relative"
          display="inline-flex"
          alignItems="center"
          gap={3}
          px={4}
          py={3}
        >
          <Spinner size="lg" />
          {label ? <Box fontWeight={500}>{label}</Box> : null}
        </Box>
      </Box>
    </Portal>
  );
}
