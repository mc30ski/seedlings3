import { HStack, Image, Text } from "@chakra-ui/react";

type Props = {
  size?: number; // pixel height for the icon
  showText?: boolean;
};

export default function BrandLabel({ size = 20, showText = true }: Props) {
  // Prefer the local file in /public; fall back to your hosted URL if needed.
  const src = "/seedlings-icon.png";

  return (
    <HStack gap="2" align="center">
      <Image
        src={src}
        alt="Seedlings Lawn Care"
        height={`${size}px`}
        width="auto"
        // Keep icon crisp on retina
        style={{ imageRendering: "auto", display: "block" }}
      />
      {showText && (
        <Text fontWeight="semibold" lineHeight="1" whiteSpace="nowrap">
          Seedlings Lawn Care
        </Text>
      )}
    </HStack>
  );
}
