import { HStack, Box, Text } from "@chakra-ui/react";

export default function InlineMessage({
  type,
  msg,
}: {
  type: "SUCCESS" | "WARNING" | "INFO" | "ERROR";
  msg: string;
}) {
  const color =
    type === "SUCCESS"
      ? "green"
      : type === "WARNING"
        ? "orange"
        : type === "INFO"
          ? "gray"
          : "red";

  return (
    <HStack
      w="full"
      mt={2}
      align="start"
      p={2.5}
      borderRadius="md"
      borderWidth="1px"
      borderColor={`${color}.300`}
      bg={`${color}.50`}
      mb={2}
    >
      <Box flex="1">
        <Text fontSize="sm" color={`${color}.900`}>
          {msg}
        </Text>
      </Box>
    </HStack>
  );
}
