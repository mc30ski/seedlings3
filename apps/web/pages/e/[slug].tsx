"use client";

import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth, RedirectToSignIn } from "@clerk/clerk-react";
import { Box, Spinner, Text, VStack } from "@chakra-ui/react";

/**
 * /e/[slug] — Short URL for equipment QR codes.
 * If not signed in, redirects to Clerk sign-in (then back here).
 * If signed in, stores the slug in sessionStorage and redirects to the main app,
 * which picks it up and navigates to the Equipment tab filtered to that item.
 */
export default function EquipmentRedirect() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const slug = router.query.slug as string | undefined;

  useEffect(() => {
    if (!isLoaded || !slug) return;
    if (!isSignedIn) return; // handled by RedirectToSignIn below

    // Store slug for the Equipment tab to pick up
    sessionStorage.setItem("equipmentQrSlug", slug);
    router.replace("/");
  }, [isLoaded, isSignedIn, slug]);

  // Not loaded yet — show spinner
  if (!isLoaded) {
    return (
      <Box minH="100vh" display="flex" alignItems="center" justifyContent="center">
        <VStack gap={3}>
          <Spinner size="lg" />
          <Text color="fg.muted" fontSize="sm">Loading...</Text>
        </VStack>
      </Box>
    );
  }

  // Not signed in — redirect to Clerk sign-in, then back to this page
  if (!isSignedIn) {
    return <RedirectToSignIn afterSignInUrl={`/e/${slug}`} />;
  }

  // Signed in — show loading while redirecting
  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center">
      <VStack gap={3}>
        <Spinner size="lg" />
        <Text color="fg.muted" fontSize="sm">Loading equipment...</Text>
      </VStack>
    </Box>
  );
}
