// apps/web/pages/_app.tsx
import type { AppProps } from "next/app";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect, useRef, useState } from "react";
import {
  ChakraProvider,
  defaultSystem,
  Box,
  HStack,
  Spinner,
  Text,
} from "@chakra-ui/react";
import Head from "next/head";
import { setAuthTokenFetcher } from "../src/lib/api";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
}

/** Custom pull-to-refresh with a visible overlay, works in iOS standalone and normal browsers */
function PullToRefresh() {
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);
  const [offset, setOffset] = useState(0); // current pull distance in px
  const [state, setState] = useState<
    "idle" | "pulling" | "ready" | "refreshing"
  >("idle");

  const THRESHOLD = 70; // px
  const MAX_PULL = 140; // px (cap for UI)

  useEffect(() => {
    const isTouch =
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0);

    if (!isTouch) return;

    const onTouchStart = (e: TouchEvent) => {
      // Only begin when scrolled to the very top
      if (window.scrollY > 0 || state === "refreshing") return;
      startY.current = e.touches[0].clientY;
      pulling.current = true;
      setState("pulling");
      setOffset(0);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling.current || startY.current == null || state === "refreshing")
        return;
      const dy = e.touches[0].clientY - startY.current;

      // If pulling down at the top, prevent the native rubber-band and show our overlay
      if (dy > 0 && window.scrollY <= 0) {
        e.preventDefault(); // needs passive: false on listener
        const clamped = Math.min(dy, MAX_PULL);
        setOffset(clamped);
        setState(clamped >= THRESHOLD ? "ready" : "pulling");
      }
    };

    const triggerRefresh = () => {
      setState("refreshing");
      // Keep overlay visible; perform a hard refresh (more reliable in iOS standalone)
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("_ts", String(Date.now()));
        window.location.replace(url.toString());
      } catch {
        window.location.reload();
      }
    };

    const onTouchEnd = () => {
      if (!pulling.current) return;
      pulling.current = false;

      if (state === "ready") {
        triggerRefresh();
      } else {
        // Snap overlay back up
        setState("idle");
        setOffset(0);
      }
      startY.current = null;
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [state]);

  // Overlay UI
  // Visual height of the banner (not counting safe-area padding)
  const PTR_HEIGHT = 56; // px
  // Translate from above the viewport: -PTR_HEIGHT -> 0 as you pull
  const translateY = Math.max(0, offset) - PTR_HEIGHT;

  const label =
    state === "refreshing"
      ? "Refreshing…"
      : state === "ready"
        ? "Release to refresh"
        : "Pull to refresh";

  return (
    <Box
      position="fixed"
      top={0}
      left={0}
      right={0}
      height={`${PTR_HEIGHT}px`}
      pt="env(safe-area-inset-top, 0px)"
      zIndex="modal"
      pointerEvents="none"
      bgGradient="linear(to-b, var(--chakra-colors-green-50), transparent)"
      borderBottomWidth="1px"
      borderColor="green.100"
      style={{
        transform: `translateY(${translateY}px)`,
        transition:
          pulling.current || state === "pulling"
            ? "none"
            : "transform 150ms ease",
        willChange: "transform",
      }}
    >
      <HStack h="full" align="center" justify="center" gap="2">
        {state === "refreshing" ? <Spinner size="sm" /> : null}
        <Text fontSize="sm" color="gray.700">
          {label}
        </Text>
      </HStack>
    </Box>
  );
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
      {/* Global CSS & small brand color nudge */}
      <style jsx global>{`
        :root {
          --chakra-colors-green-50: #eaf7ee; /* subtle Seedlings wash */
        }
        html,
        body {
          overscroll-behavior-y: contain; /* prevent native glow; we handle pull */
          background-color: var(--chakra-colors-bg);
        }
      `}</style>

      {/* Safe-area padding so brand/header isn't under the Dynamic Island */}
      <Box pt={TOP_SAFE_PAD}>
        {/* Custom pull-to-refresh with visible overlay */}
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
