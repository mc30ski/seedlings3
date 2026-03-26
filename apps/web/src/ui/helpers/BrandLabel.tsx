import { HStack, Image, Text, Box } from "@chakra-ui/react";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/clerk-react";

type Props = {
  /** Pixel height for the icon */
  size?: number;
  /** Show "Seedlings Lawn Care" text next to the icon */
  showText?: boolean;
  /** Hide the right-side auth controls if you need a bare brand label somewhere else */
  showUserControls?: boolean;
};

export default function BrandLabel({
  size = 20,
  showText = true,
  showUserControls = true,
}: Props) {
  const src = "/seedlings-icon.png";
  const lineMinH = Math.max(size, 32); // keep row tall enough for the avatar button

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
        <Image
          src={src}
          alt="Seedlings Lawn Care"
          height={`${size}px`}
          width="auto"
          style={{ imageRendering: "auto", display: "block" }}
        />
        {showText && (
          <Text fontWeight="semibold" lineHeight="1" whiteSpace="nowrap">
            Seedlings Lawn Care
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
