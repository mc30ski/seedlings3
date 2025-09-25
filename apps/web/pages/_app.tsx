// apps/web/pages/_app.tsx
import type { AppProps } from "next/app";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect, useState, useCallback } from "react";
import {
  ChakraProvider,
  defaultSystem,
  HStack,
  Button,
  Badge,
  Box,
} from "@chakra-ui/react";
import { FiAlertCircle } from "react-icons/fi";
import { setAuthTokenFetcher, apiGet } from "../src/lib/api";
import Head from "next/head";
import { useRouter } from "next/router";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
}

type Me = {
  id: string;
  isApproved: boolean;
  roles: ("ADMIN" | "WORKER")[];
  email?: string | null;
  displayName?: string | null;
};

function AppInner({ Component, pageProps }: AppProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  // Wire Clerk token into API client
  useEffect(() => {
    setAuthTokenFetcher(() => getToken());
  }, [getToken]);

  // Top-right approvals indicator state
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  const isAdmin = !!me?.isApproved && (me?.roles || []).includes("ADMIN");

  const loadMe = useCallback(async () => {
    try {
      const m = await apiGet<Me>("/api/me");
      setMe(m);
    } catch {
      setMe(null);
    }
  }, []);

  const loadPending = useCallback(async () => {
    // Only admins need pending count
    if (!isAdmin) {
      setPending(null);
      return;
    }
    try {
      const res = await apiGet<{ pending: number }>(
        "/api/admin/users/pendingCount"
      );
      const count = res?.pending ?? 0;
      setPending(count);
    } catch {
      // If the endpoint isn't reachable, just hide the alert
      setPending(0);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  useEffect(() => {
    void loadPending();
  }, [loadPending, me]);

  // Refresh pending count when users change (approve/remove/etc)
  useEffect(() => {
    const onUsersChanged = () => void loadPending();
    window.addEventListener("seedlings3:users-changed", onUsersChanged);
    return () =>
      window.removeEventListener("seedlings3:users-changed", onUsersChanged);
  }, [loadPending]);

  return (
    <ChakraProvider value={defaultSystem}>
      {/* header */}
      <HStack justify="flex-end" px="4" py="2" gap="3">
        {/* Show Approvals button only if admin AND pending > 0 */}
        {isAdmin && (pending ?? 0) > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              router.push({
                pathname: "/",
                query: { adminTab: "users", status: "pending" },
              })
            }
            title="Pending approvals"
            position="relative"
          >
            <HStack gap="2">
              <FiAlertCircle />
              <span>Approvals</span>
              <Box
                as="span"
                position="absolute"
                top="-2px"
                right="-2px"
                fontSize="11px"
                minWidth="18px"
                height="18px"
                lineHeight="18px"
                textAlign="center"
                borderRadius="9999px"
                background="tomato"
                color="white"
                px="1"
              >
                {pending}
              </Box>
            </HStack>
          </Button>
        ) : null}
        <UserButton />
      </HStack>

      <SignedIn>
        <Component {...pageProps} />
      </SignedIn>

      <SignedOut>
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 40 }}
        >
          <SignIn routing="hash" />
        </div>
      </SignedOut>
    </ChakraProvider>
  );
}

export default function MyApp(props: AppProps) {
  return (
    <>
      <Head>
        {/* --- PWA / iOS standalone meta for app-like experience from Home Screen --- */}
        {/* Required for iOS "Add to Home Screen" to open without Safari chrome */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Status bar appearance when launched from Home Screen */}
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        {/* Title under the Home Screen icon */}
        <meta name="apple-mobile-web-app-title" content="Seedlings" />
        {/* Allow edge-to-edge layouts; important for notched devices */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />

        {/* Web App Manifest (also used by iOS nowadays) */}
        <link rel="manifest" href="/manifest.webmanifest" />
        {/* Theme color for splash / UIs that respect it */}
        <meta name="theme-color" content="#0a7cff" />

        {/* Favicon / bookmark icons */}
        <link rel="icon" href="/seedlings-icon.png" />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/seedlings-icon-32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/seedlings-icon-16.png"
        />
        {/* iOS home screen icon */}
        <link rel="apple-touch-icon" href="/seedlings-icon.png" />
        {/* Optional: larger touch icons if you have them
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png" />
        */}
      </Head>

      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <AppInner {...props} />
      </ClerkProvider>
    </>
  );
}
