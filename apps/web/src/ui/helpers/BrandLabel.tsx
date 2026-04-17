import { useEffect, useState } from "react";
import { HStack, Text, Box } from "@chakra-ui/react";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/clerk-react";

function resolveIcon(): string {
  if (typeof window === "undefined") return "/seedlings-icon.png";
  try {
    const override = localStorage.getItem("seedlings_seasonOverride");
    if (override === "fall") return "/seedlings-icon-fall.png";
    if (override === "spring") return "/seedlings-icon.png";
  } catch {}
  // Auto — check month
  const month = new Date().getMonth();
  return (month >= 2 && month <= 7) ? "/seedlings-icon.png" : "/seedlings-icon-fall.png";
}

type Props = {
  /** Pixel height for the icon */
  size?: number;
  /** Show "Seedlings" text next to the icon */
  showText?: boolean;
  /** Hide the right-side auth controls if you need a bare brand label somewhere else */
  showUserControls?: boolean;
};

export default function BrandLabel({
  size = 20,
  showText = true,
  showUserControls = true,
}: Props) {
  const [iconSrc, setIconSrc] = useState("/seedlings-icon.png");

  useEffect(() => {
    setIconSrc(resolveIcon());
    const handler = () => setIconSrc(resolveIcon());
    window.addEventListener("seedlings:seasonChanged", handler);
    return () => window.removeEventListener("seedlings:seasonChanged", handler);
  }, []);

  const lineMinH = Math.max(size, 32);

  return (
    <HStack
      gap="2"
      align="center"
      justify="space-between"
      w="100%"
      minH={`${lineMinH}px`}
    >
      {/* Left: brand */}
      <HStack gap="2" align="center">
        <img
          key={iconSrc}
          src={iconSrc}
          alt="Seedlings"
          height={size}
          style={{ height: `${size}px`, width: "auto", imageRendering: "auto", display: "block" }}
        />
        {showText && (
          <Text fontSize="sm" fontWeight="bold" lineHeight="1" whiteSpace="nowrap">
            Seedlings
          </Text>
        )}
      </HStack>

      {/* Right: auth controls (Clerk) */}
      {showUserControls && (
        <Box>
          <SignedIn>
            <UserButton />
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <Text
                as="button"
                fontSize="sm"
                color="blue.600"
                _hover={{ textDecoration: "underline" }}
              >
                Sign in
              </Text>
            </SignInButton>
          </SignedOut>
        </Box>
      )}
    </HStack>
  );
}
