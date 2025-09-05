// pages/_app.tsx
import type { AppProps } from "next/app";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignIn,
  UserButton,
  useAuth,
} from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { setAuthTokenFetcher } from "../src/lib/api";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
}

function AppInner({ Component, pageProps }: AppProps) {
  const { getToken, isLoaded } = useAuth();
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    // Install the fetcher so API calls include a fresh Clerk token.
    setAuthTokenFetcher(() => getToken({ skipCache: true }));
    setAuthReady(true);
  }, [isLoaded, getToken]);

  // Until Clerk is ready and the token fetcher is installed, don't render pages.
  if (!isLoaded || !authReady) {
    return null; // or a small loading shell if you prefer
  }

  return (
    <ChakraProvider value={defaultSystem}>
      {/* Header with user menu (only when signed in) */}
      <SignedIn>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "8px 16px",
          }}
        >
          <UserButton />
        </div>
      </SignedIn>

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
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <AppInner {...props} />
    </ClerkProvider>
  );
}
