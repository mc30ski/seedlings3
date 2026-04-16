"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { FiPlus, FiDownload, FiDatabase, FiShare2 } from "react-icons/fi";

type TaskDef = {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  colorPalette: string;
  bgColor: string;
  onClick: () => void;
  disabled?: boolean;
  disabledMessage?: string;
};

type Props = {
  tasks: TaskDef[];
};

export default function AdminTasksTab({ tasks }: Props) {
  return (
    <Box w="full" pb={8}>
      <Box mb={3} p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
        <Text fontSize="sm" fontWeight="medium" color="yellow.700">Actions</Text>
        <Text fontSize="xs" color="yellow.600">
          Workflows that guide you through multi-step processes. Each action chains together the steps needed to get the job done — from setup to completion.
        </Text>
      </Box>
      <VStack align="stretch" gap={3} pt={2}>
        {tasks.map((task) => (
          <Box
            key={task.id}
            as="button"
            onClick={task.onClick}
            p={5}
            rounded="xl"
            borderWidth="1px"
            borderColor={task.disabled ? "gray.200" : `${task.colorPalette}.200`}
            bg={task.disabled ? "gray.50" : task.bgColor}
            textAlign="left"
            cursor={task.disabled ? "default" : "pointer"}
            opacity={task.disabled ? 0.7 : 1}
            transition="all 0.15s"
            _hover={task.disabled ? {} : { shadow: "md", borderColor: `${task.colorPalette}.400` }}
            _active={task.disabled ? {} : { shadow: "sm" }}
            display="flex"
            alignItems="center"
            gap={4}
          >
            <Box
              p={3}
              rounded="lg"
              bg={task.disabled ? "gray.100" : `${task.colorPalette}.100`}
              color={task.disabled ? "gray.400" : `${task.colorPalette}.600`}
              display="flex"
              alignItems="center"
              justifyContent="center"
              flexShrink={0}
            >
              <task.icon size={24} />
            </Box>
            <Box flex="1">
              <Text fontWeight="semibold" fontSize="md" color={task.disabled ? "gray.500" : `${task.colorPalette}.800`}>
                {task.label}
              </Text>
              <Text fontSize="sm" color={task.disabled ? "gray.400" : `${task.colorPalette}.600`} mt={0.5}>
                {task.disabled && task.disabledMessage ? task.disabledMessage : task.description}
              </Text>
            </Box>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

export { type TaskDef };
export { FiPlus, FiDownload, FiDatabase, FiShare2 };
