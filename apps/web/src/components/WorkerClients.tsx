import { Box, Center, Heading, Text, Stack, Badge } from "@chakra-ui/react";

export default function WorkerClients() {
  return (
    <Center minH="240px">
      <Box
        p={{ base: 5, md: 8 }}
        borderWidth="1px"
        borderRadius="xl"
        maxW="lg"
        textAlign="center"
      >
        <Stack gap="3" align="center">
          <Badge size="lg" variant="solid" colorPalette="gray">
            Coming soon
          </Badge>
          <Heading size="md">Clients</Heading>
          <Text color="gray.600">
            We’re building this soon. You’ll be able to view client info and
            manage client interactions here.
          </Text>
        </Stack>
      </Box>
    </Center>
  );
}
