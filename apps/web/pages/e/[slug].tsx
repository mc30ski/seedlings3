"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth, RedirectToSignIn } from "@clerk/clerk-react";
import { Box, Spinner, Text, VStack } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";

/**
 * /e/[slug] — Short URL for equipment QR codes.
 * 1. If not signed in → Clerk sign-in → returns here
 * 2. If signed in → calls API to look up equipment + user's checkout state
 * 3. Stores result in sessionStorage → redirects to / → Equipment tab shows dialog
 */
export default function EquipmentRedirect() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const slug = router.query.slug as string | undefined;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !slug) return;
    if (!isSignedIn) return;

    // Call the API to look up equipment and determine action
    apiGet<{ equipment: any; userHasReservation: boolean; userHasCheckout: boolean }>(
      `/api/equipment/by-slug/${encodeURIComponent(slug)}`
    )
      .then((result) => {
        // Store the full result so EquipmentTab can show dialog immediately
        sessionStorage.setItem("equipmentQrResult", JSON.stringify({
          slug,
          equipmentId: result.equipment.id,
          equipmentLabel: result.equipment.shortDesc || `${result.equipment.brand} ${result.equipment.model}`,
          userHasReservation: result.userHasReservation,
          userHasCheckout: result.userHasCheckout,
        }));
        router.replace("/");
      })
      .catch((err) => {
        // If the lookup fails (404, network, etc.), just navigate with slug for search
        console.error("Equipment lookup failed:", err);
        setError(err?.message || "Equipment not found");
        // Still redirect after a moment so user can at least see the equipment tab
        sessionStorage.setItem("equipmentQrResult", JSON.stringify({ slug, equipmentId: null }));
        setTimeout(() => router.replace("/"), 2000);
      });
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
        {error ? (
          <Text color="red.500" fontSize="sm">{error}</Text>
        ) : (
          <Text color="fg.muted" fontSize="sm">Loading equipment...</Text>
        )}
      </VStack>
    </Box>
  );
}
