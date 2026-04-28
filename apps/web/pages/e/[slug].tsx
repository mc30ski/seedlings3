"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { useAuth, RedirectToSignIn } from "@clerk/clerk-react";
import { Box, Spinner, Text, VStack } from "@chakra-ui/react";
import { setAuthTokenFetcher } from "@/src/lib/api";
import { apiGet } from "@/src/lib/api";

/**
 * /e/[slug] — Short URL for equipment QR codes.
 * 1. If not signed in → Clerk sign-in → returns here
 * 2. If signed in → calls API to look up equipment + user's checkout state
 * 3. Stores result in sessionStorage → redirects to / → Equipment tab shows dialog
 */
export default function EquipmentRedirect() {
  const router = useRouter();
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const slug = router.query.slug as string | undefined;
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  // Ensure the API client has the auth token (same as _app.tsx does)
  useEffect(() => {
    setAuthTokenFetcher(() => getToken());
  }, [getToken]);

  const doLookup = useCallback(async () => {
    if (!slug) return;
    try {
      const result = await apiGet<{ equipment: any; userHasReservation: boolean; userHasCheckout: boolean }>(
        `/api/equipment/by-slug/${encodeURIComponent(slug)}`
      );
      sessionStorage.setItem("equipmentQrResult", JSON.stringify({
        slug,
        equipmentId: result.equipment?.id ?? null,
        equipmentLabel: result.equipment?.shortDesc || `${result.equipment?.brand ?? ""} ${result.equipment?.model ?? ""}`.trim(),
        userHasReservation: result.userHasReservation ?? false,
        userHasCheckout: result.userHasCheckout ?? false,
      }));
      router.replace("/");
    } catch (err: any) {
      console.error("Equipment lookup failed:", err);
      setError(err?.message || "Unknown error");
      // Still redirect so user can see the equipment tab filtered by slug
      sessionStorage.setItem("equipmentQrResult", JSON.stringify({ slug, equipmentId: null }));
      setTimeout(() => router.replace("/"), 4000);
    }
  }, [slug, router]);

  useEffect(() => {
    if (!isLoaded || !slug || !isSignedIn || attempted) return;
    // Small delay to ensure auth token fetcher is wired up
    setAttempted(true);
    const timer = setTimeout(() => void doLookup(), 300);
    return () => clearTimeout(timer);
  }, [isLoaded, isSignedIn, slug, attempted, doLookup]);

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
