// apps/web/pages/_app.tsx
import type { AppProps } from "next/app";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect, useMemo, useState } from "react";
import { ChakraProvider, defaultSystem, Box } from "@chakra-ui/react";
import Head from "next/head";
import { setAuthTokenFetcher } from "../src/lib/api";
import PWAPullToRefresh from "../src/ui/helpers/PWAPullToRefresh";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
}

function AppInner({ Component, pageProps }: AppProps) {
  const { getToken } = useAuth();

  // Wire Clerk token into API client
  useEffect(() => {
    setAuthTokenFetcher(() => getToken());
  }, [getToken]);

  // Detect standalone (Home Screen) display mode
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const detect = () =>
      (window.navigator as any).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)")?.matches === true;
    setStandalone(detect());

    // Re-check on visibility/resizes (rare but cheap)
    const onChange = () => setStandalone(detect());
    window.addEventListener("visibilitychange", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  // Minimize top gap:
  // - In standalone: exactly the safe-area inset (tight, clears Dynamic Island).
  // - In browsers: tiny 2px breathing room.
  const TOP_PAD = useMemo(
    () => (standalone ? "env(safe-area-inset-top, 0px)" : "2px"),
    [standalone]
  );

  return (
    <ChakraProvider value={defaultSystem}>
      {/* Apply minimal, mode-aware padding so the brand/header never sits under the status bar */}
      <Box pt={TOP_PAD}>
        {/* Custom pull-to-refresh remains enabled (appears in standalone, no-op in browsers) */}
        <PWAPullToRefresh />

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
      </Box>
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
