import { HStack, Box, Text } from "@chakra-ui/react";

export enum InlineMessageType {
  SUCCESS = "SUCCESS",
  WARNING = "WARNING",
  INFO = "INFO",
  ERROR = "ERROR",
}

export default function InlineMessage({
  type,
  msg,
}: {
  type: InlineMessageType;
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
      <Box flex="1" minW={0}>
        <Text
          fontSize="sm"
          color={`${color}.900`}
          whiteSpace="normal"
          overflowWrap="anywhere"
          wordBreak="break-word"
          hyphens="auto"
        >
          {msg}
        </Text>
      </Box>
    </HStack>
  );
}
