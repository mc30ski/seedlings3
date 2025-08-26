import { Container, Heading, Text } from "@chakra-ui/react";
import { NavButtons } from "../components/NavButtons";

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
