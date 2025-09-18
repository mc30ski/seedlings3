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
} from "@chakra-ui/react";
import { FiAlertCircle } from "react-icons/fi";
import { setAuthTokenFetcher, apiGet } from "../src/lib/api";
import Head from "next/head";

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
      const m = await apiGet<Me>("/api/_proxy/api/me");
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
      setPending(res.pending ?? 0);
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
  }, [loadPending]);

  // Refresh pending count when users change (approve/remove/etc)
  useEffect(() => {
    const onUsersChanged = () => void loadPending();
    window.addEventListener("seedlings3:users-changed", onUsersChanged);
    return () =>
      window.removeEventListener("seedlings3:users-changed", onUsersChanged);
  }, [loadPending]);

  const gotoPendingApprovals = () => {
    try {
      // Tell the app to switch to Admin → Users and show "Pending"
      window.dispatchEvent(
        new CustomEvent("seedlings3:open-users", {
          detail: { status: "pending" },
        })
      );
    } catch {}
  };

  return (
    <ChakraProvider value={defaultSystem}>
      {/* header */}
      <HStack justify="flex-end" px="4" py="2" gap="3">
        {/* Show Approvals button only if admin AND pending > 0 */}
        {isAdmin && (pending ?? 0) > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={gotoPendingApprovals}
            title="Pending approvals"
          >
            <HStack gap="2">
              <FiAlertCircle />
              <span>Approvals</span>
              <Badge>{pending}</Badge>
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
        {/* Favicon / bookmark icons */}
        <link rel="icon" href="/seedlings-icon.png" />
        {/* Use crisp sizes if you added them */}
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
        {/* Title is optional here; keep your existing <title> if you have one elsewhere */}
      </Head>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <AppInner {...props} />
      </ClerkProvider>
    </>
  );
}
