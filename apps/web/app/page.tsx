import { Container, Heading, Text } from "@chakra-ui/react";
import { NavButtons } from "../components/NavButtons";

// HStack gap={3} mt={6}  (not spacing)
// Button colorPalette="brand"  (not colorScheme)
// navigate with a small client component or NextLink + as="a" (no href on Button itself)

export default function Page() {
  return (
    <Container maxW="container.sm" py={6}>
      <Heading size="lg">Hello World (Web)</Heading>
      <Text mt={2} color="gray.600">
        Deployed and responsive. Try me on a phone!
      </Text>
      <NavButtons />
    </Container>
  );
}
