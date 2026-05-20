"use client";

import { SignIn } from "@clerk/clerk-react";
import { Box, Heading, Text, VStack } from "@chakra-ui/react";

/**
 * Dedicated client-friendly sign-in page.
 *
 * Passwordless sign-in via an email verification CODE: the client enters
 * their email and types back the 6-digit code we send — no password, and
 * (unlike an email link) no leaving the page, which converts better on
 * mobile. Requires, in the Clerk dashboard, "Email verification code"
 * enabled for BOTH sign-up and sign-in with email, with the email-link
 * option off. Clerk's <SignIn /> component renders whichever method is
 * configured, so this page just needs the standard component.
 */
export default function SignInPage() {
  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center" bg="gray.50" p={4}>
      <VStack gap={4} maxW="md" w="full">
        <Heading size="lg" textAlign="center">Welcome to Seedlings</Heading>
        <Text fontSize="sm" color="fg.muted" textAlign="center">
          Enter your email — we'll send you a verification code to type in.
          New here or returning, it's the same step.
        </Text>
        <SignIn
          path="/sign-in"
          routing="path"
          signUpUrl="/sign-in"
          forceRedirectUrl="/"
          appearance={{
            elements: {
              // Center the Clerk card under the centered heading/text — the
              // card has its own fixed width, so the rootBox must center it.
              rootBox: { width: "100%", display: "flex", justifyContent: "center" },
              card: { boxShadow: "0 4px 24px rgba(0,0,0,0.06)" },
            },
          }}
        />
      </VStack>
    </Box>
  );
}
