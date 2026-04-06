"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { FiPlus, FiDownload, FiDatabase } from "react-icons/fi";

type TaskDef = {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  colorPalette: string;
  bgColor: string;
  onClick: () => void;
};

type Props = {
  tasks: TaskDef[];
};

export default function AdminTasksTab({ tasks }: Props) {
  return (
    <Box w="full" pb={8}>
      <VStack align="stretch" gap={3} pt={2}>
        {tasks.map((task) => (
          <Box
            key={task.id}
            as="button"
            onClick={task.onClick}
            p={5}
            rounded="xl"
            borderWidth="1px"
            borderColor={`${task.colorPalette}.200`}
            bg={task.bgColor}
            textAlign="left"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ shadow: "md", borderColor: `${task.colorPalette}.400` }}
            _active={{ shadow: "sm" }}
            display="flex"
            alignItems="center"
            gap={4}
          >
            <Box
              p={3}
              rounded="lg"
              bg={`${task.colorPalette}.100`}
              color={`${task.colorPalette}.600`}
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexShrink={0}
            >
              <task.icon size={24} />
            </Box>
            <Box flex="1">
              <Text fontWeight="semibold" fontSize="md" color={`${task.colorPalette}.800`}>
                {task.label}
              </Text>
              <Text fontSize="sm" color={`${task.colorPalette}.600`} mt={0.5}>
                {task.description}
              </Text>
            </Box>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

export { type TaskDef };
export { FiPlus, FiDownload, FiDatabase };
