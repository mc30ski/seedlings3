// apps/web/pages/_app.tsx
import type { AppProps } from "next/app";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect, useRef } from "react";
import { ChakraProvider, defaultSystem, Box } from "@chakra-ui/react";
import Head from "next/head";
import { setAuthTokenFetcher } from "../src/lib/api";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
}

/** Lightweight pull-to-refresh that works in iOS standalone (and normal browsers) */
function PullToRefresh() {
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);
  const threshold = 70; // px

  useEffect(() => {
    const isTouch =
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0);

    if (!isTouch) return;

    const onTouchStart = (e: TouchEvent) => {
      // only when scrolled to top
      if (window.scrollY > 0) return;
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling.current || startY.current == null) return;
      const dy = e.touches[0].clientY - startY.current;
      // Stop overscroll bounce while pulling
      if (dy > 0 && window.scrollY <= 0) {
        e.preventDefault();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!pulling.current || startY.current == null) return;
      const dy = (e.changedTouches[0]?.clientY ?? 0) - startY.current;
      startY.current = null;
      pulling.current = false;
      if (dy > threshold) {
        // hard refresh (most reliable for iOS standalone)
        try {
          // cache-bust just in case
          const url = new URL(window.location.href);
          url.searchParams.set("_ts", String(Date.now()));
          window.location.replace(url.toString());
        } catch {
          window.location.reload();
        }
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  return null;
}

function AppInner({ Component, pageProps }: AppProps) {
  const { getToken } = useAuth();

  // Wire Clerk token into API client
  useEffect(() => {
    setAuthTokenFetcher(() => getToken());
  }, [getToken]);

  // Push content below iOS status area in standalone mode,
  // but only a tiny 8px cushion on normal browsers.
  const TOP_SAFE_PAD = "calc(env(safe-area-inset-top, 0px) + 8px)";

  return (
    <ChakraProvider value={defaultSystem}>
      {/* Global CSS nudge for the brand wash (used by header on index.tsx) */}
      <style jsx global>{`
        :root {
          /* Slightly softer green-50 if you use it for the header wash */
          --chakra-colors-green-50: #eaf7ee;
        }
        /* Prevent body overscroll glow on iOS */
        html,
        body {
          overscroll-behavior-y: contain;
          background-color: var(--chakra-colors-bg);
        }
      `}</style>

      {/* Keep safe-area padding so the brand row isn't under the Dynamic Island */}
      <Box pt={TOP_SAFE_PAD}>
        {/* Custom pull-to-refresh preserved */}
        <PullToRefresh />

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
