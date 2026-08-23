"use client";

import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth, RedirectToSignIn } from "@clerk/clerk-react";
import { Box, Spinner, Text, VStack } from "@chakra-ui/react";

/**
 * /e/[equipmentCode] — Short URL behind the equipment QR stickers.
 * Stores the code and redirects into the app.
 * The Equipment tab handles the API lookup and checkout/return dialog.
 */
export default function EquipmentRedirect() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const equipmentCode = router.query.equipmentCode as string | undefined;

  useEffect(() => {
    if (!isLoaded || !equipmentCode) return;
    if (!isSignedIn) return;
    sessionStorage.setItem("equipmentQrSlug", equipmentCode);
    router.replace("/");
  }, [isLoaded, isSignedIn, equipmentCode]);

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
    return <RedirectToSignIn redirectUrl={`/e/${equipmentCode}`} />;
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
