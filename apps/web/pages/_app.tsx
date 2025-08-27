import type { AppProps } from "next/app";
import "../src/styles/globals.css";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { Toaster } from "../src/components/ui/toaster"; // from the toaster snippet

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ChakraProvider value={defaultSystem}>
      <Toaster />
      <Component {...pageProps} />
    </ChakraProvider>
  );
}
