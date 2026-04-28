"use client";

import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth, RedirectToSignIn } from "@clerk/clerk-react";
import { Box, Spinner, Text, VStack } from "@chakra-ui/react";

/**
 * /e/[slug] — Short URL for equipment QR codes.
 * Simply stores the slug and redirects to the main app.
 * The Equipment tab handles the API lookup and checkout/return dialog.
 */
export default function EquipmentRedirect() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const slug = router.query.slug as string | undefined;

  useEffect(() => {
    if (!isLoaded || !slug) return;
    if (!isSignedIn) return;
    sessionStorage.setItem("equipmentQrSlug", slug);
    router.replace("/");
  }, [isLoaded, isSignedIn, slug]);

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

  if (!isSignedIn) {
    return <RedirectToSignIn redirectUrl={`/e/${slug}`} />;
  }

  return (
    <Box minH="100vh" display="flex" alignItems="center" justifyContent="center">
      <VStack gap={3}>
        <Spinner size="lg" />
        <Text color="fg.muted" fontSize="sm">Opening equipment...</Text>
      </VStack>
    </Box>
  );
}
