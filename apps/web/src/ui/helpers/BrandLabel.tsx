import { useEffect, useState } from "react";
import Link from "next/link";
import { HStack, Text, Box } from "@chakra-ui/react";
import {
  SignedIn,
  SignedOut,
  UserButton,
} from "@clerk/clerk-react";
import { bizMonth } from "@/src/lib/lib";

function resolveIcon(): string {
  if (typeof window === "undefined") return "/seedlings-icon.png";
  try {
    const override = localStorage.getItem("seedlings_seasonOverride");
    if (override === "fall") return "/seedlings-icon-fall.png";
    if (override === "spring") return "/seedlings-icon.png";
  } catch {}
  // Auto — check the current ET month (NOT browser-local). Mar (3) –
  // Aug (8) = spring/summer icon. Mirrors the rule in lib/season.ts.
  const month = bizMonth();
  return (month >= 3 && month <= 8) ? "/seedlings-icon.png" : "/seedlings-icon-fall.png";
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
      <HStack gap="2" align="center" minW="0" overflow="hidden" flexShrink={1}>
        <img
          key={iconSrc}
          src={iconSrc}
          alt="Seedlings"
          height={size}
          style={{ height: `${size}px`, width: "auto", imageRendering: "auto", display: "block", flexShrink: 0 }}
        />
        {showText && (
          <Text fontSize="sm" fontWeight="bold" lineHeight="1" whiteSpace="nowrap" overflow="hidden" textOverflow="clip">
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
            {/* Route through our custom /sign-in page (unified passwordless +
             *  password flow) instead of Clerk's stock modal — the modal
             *  doesn't show the password field by default for users who
             *  have one set; our flow does. */}
            <Link href="/sign-in" legacyBehavior>
              <Text
                as="a"
                fontSize="sm"
                color="blue.600"
                cursor="pointer"
                _hover={{ textDecoration: "underline" }}
              >
                Sign in
              </Text>
            </Link>
          </SignedOut>
        </Box>
      )}
    </HStack>
  );
}
