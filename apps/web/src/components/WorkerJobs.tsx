import { Box, Center, Heading, Text, Stack, Badge } from "@chakra-ui/react";

export default function WorkerJobs() {
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
          <Heading size="md">Jobs</Heading>
          <Text color="gray.600">
            We’re building this soon. You’ll be able to browse and claim lawn
            care jobs right here.
          </Text>
        </Stack>
      </Box>
    </Center>
  );
}
