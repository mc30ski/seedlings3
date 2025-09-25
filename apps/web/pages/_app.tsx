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

  // Approvals badge state
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
    if (!isAdmin) {
      setPending(null);
      return;
    }
    try {
      const res = await apiGet<{ pending: number }>(
        "/api/admin/users/pendingCount"
      );
      setPending(res?.pending ?? 0);
    } catch {
      setPending(0);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);
  useEffect(() => {
    void loadPending();
  }, [loadPending, me]);
  useEffect(() => {
    const onUsersChanged = () => void loadPending();
    window.addEventListener("seedlings3:users-changed", onUsersChanged);
    return () =>
      window.removeEventListener("seedlings3:users-changed", onUsersChanged);
  }, [loadPending]);

  // Place controls just below iOS status bar (0px on desktop browsers)
  const TOP_OFFSET = "calc(env(safe-area-inset-top, 0px) + 6px)";

  return (
    <ChakraProvider value={defaultSystem}>
      {/* Overlayed controls only (no extra brand row here) */}
      <Box
        position="fixed"
        top={TOP_OFFSET}
        right="12px"
        zIndex={1000}
        // Let clicks pass through except on the buttons themselves
        pointerEvents="none"
      >
        <HStack gap="8px" pointerEvents="auto">
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
              <HStack gap="6px">
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
      </Box>

      {/* Main app content (your existing page header with Seedlings icon/text remains) */}
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
        {/* iOS standalone & PWA meta */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <meta name="apple-mobile-web-app-title" content="Seedlings" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0a7cff" />

        {/* Icons */}
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
        <link rel="apple-touch-icon" href="/seedlings-icon.png" />
      </Head>

      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <AppInner {...props} />
      </ClerkProvider>
    </>
  );
}
