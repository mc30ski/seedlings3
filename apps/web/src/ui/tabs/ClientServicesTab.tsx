"use client";

import { Box, Text, VStack } from "@chakra-ui/react";

export default function ClientServicesTab() {
  return (
    <Box w="full" pb={8}>
      <VStack align="center" gap={3} py={10}>
        <Text fontSize="lg" fontWeight="semibold">Interested in our services?</Text>
        <Text fontSize="sm" color="fg.muted" textAlign="center" maxW="sm">
          We'd love to hear from you. Visit our website or reach out directly and we'll get back to you as soon as possible.
        </Text>
        <a
          href="https://www.seedlingslawncare.com/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            padding: "8px 20px",
            borderRadius: "8px",
            backgroundColor: "var(--chakra-colors-green-600)",
            color: "white",
            fontWeight: 600,
            fontSize: "14px",
            textDecoration: "none",
          }}
        >
          Visit seedlingslawncare.com
        </a>
        <a
          href="mailto:seedlings@wanderski.com?subject=Service%20Request"
          style={{
            display: "inline-block",
            padding: "8px 20px",
            borderRadius: "8px",
            backgroundColor: "var(--chakra-colors-green-600)",
            color: "white",
            fontWeight: 600,
            fontSize: "14px",
            textDecoration: "none",
          }}
        >
          Email Us
        </a>
      </VStack>
    </Box>
  );
}
