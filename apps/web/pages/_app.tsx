// apps/web/pages/_app.tsx
import type { AppProps } from "next/app";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect } from "react";
import { ChakraProvider, defaultSystem, Box } from "@chakra-ui/react";
import Head from "next/head";
import { setAuthTokenFetcher } from "../src/lib/api";
import PWAPullToRefresh from "../src/components/PWAPullToRefresh";

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

  // Push content below iOS status area in standalone mode,
  // but only a tiny 8px cushion on normal browsers.
  const TOP_SAFE_PAD = "calc(env(safe-area-inset-top, 0px) + 8px)";

  return (
    <ChakraProvider value={defaultSystem}>
      {/* Apply safe-area padding to the whole app so the brand row isn't under the Dynamic Island */}
      <Box pt={TOP_SAFE_PAD}>
        {/* Custom pull-to-refresh only when installed as a Home-Screen app */}
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
