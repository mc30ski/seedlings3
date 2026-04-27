"use client";

import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "@clerk/clerk-react";
import { Box, Spinner, Text, VStack } from "@chakra-ui/react";

/**
 * /e/[slug] — Short URL for equipment QR codes.
 * Stores the slug in sessionStorage and redirects to the main app,
 * which picks it up and navigates to the Equipment tab filtered to that item.
 */
export default function EquipmentRedirect() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const slug = router.query.slug as string | undefined;

  useEffect(() => {
    if (!isLoaded || !slug) return;

    if (!isSignedIn) {
      // Clerk will show the sign-in UI via _app.tsx.
      // After sign-in, the user will land back on this page and the effect re-runs.
      return;
    }

    // Store slug for the Equipment tab to pick up
    sessionStorage.setItem("equipmentQrSlug", slug);
    router.replace("/");
  }, [isLoaded, isSignedIn, slug]);

  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center">
      <VStack gap={3}>
        <Spinner size="lg" />
        <Text color="fg.muted" fontSize="sm">Loading equipment...</Text>
      </VStack>
    </Box>
  );
}
