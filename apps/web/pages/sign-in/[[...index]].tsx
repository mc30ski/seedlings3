"use client";

import { SignIn } from "@clerk/clerk-react";
import { Box, Heading, Text, VStack } from "@chakra-ui/react";

/**
 * Dedicated client-friendly sign-in page.
 *
 * Magic-link sign-in: clients can paste their email and receive a sign-in link
 * — no password required. This requires "Email magic link" or "Email link"
 * to be enabled in the Clerk dashboard:
 *   Authentication → Email, Phone, Username → Email link  →  ON
 * Once enabled, Clerk's <SignIn /> component shows it as the default option
 * (above any password field), so this page just needs the standard component.
 */
export default function SignInPage() {
  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center" bg="gray.50" p={4}>
      <VStack gap={4} maxW="md" w="full">
        <Heading size="lg" textAlign="center">Welcome to Seedlings</Heading>
        <Text fontSize="sm" color="fg.muted" textAlign="center">
          Sign in with your email — we'll send you a one-tap link.
        </Text>
        <SignIn
          path="/sign-in"
          routing="path"
          signUpUrl="/sign-in"
          forceRedirectUrl="/"
          appearance={{
            elements: {
              rootBox: { width: "100%" },
              card: { boxShadow: "0 4px 24px rgba(0,0,0,0.06)" },
            },
          }}
        />
      </VStack>
    </Box>
  );
}
