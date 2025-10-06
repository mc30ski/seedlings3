import { Badge, Box, Center, Heading, Stack, Text } from "@chakra-ui/react";

type Tone = "gray" | "yellow" | "blue" | "red" | "green";

export default function StatusPanel({
  badge = "Notice",
  title,
  description,
  tone = "gray",
  minH = "240px",
}: {
  badge?: string;
  title: string;
  description?: string;
  tone?: Tone;
  minH?: string | number;
}) {
  return (
    <Center minH={minH}>
      <Box
        p={{ base: 5, md: 8 }}
        borderWidth="1px"
        borderRadius="xl"
        maxW="lg"
        textAlign="center"
      >
        <Stack gap="3" align="center">
          <Badge
            size="lg"
            variant="solid"
            colorScheme={tone as any} // Chakra v2
            colorPalette={tone as any} // Chakra v3
          >
            {badge}
          </Badge>
          <Heading size="md">{title}</Heading>
          {description ? <Text color="gray.600">{description}</Text> : null}
        </Stack>
      </Box>
    </Center>
  );
}
