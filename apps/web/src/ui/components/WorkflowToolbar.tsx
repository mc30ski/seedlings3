"use client";

import { Button, HStack, Text } from "@chakra-ui/react";

export type WorkflowDef = {
  id: string;
  label: string;
  colorPalette?: string;
  onClick: () => void;
};

type Props = {
  workflows: WorkflowDef[];
};

export default function WorkflowToolbar({ workflows }: Props) {
  if (workflows.length === 0) return null;

  return (
    <HStack gap={2} mb={3} ml={4} wrap="wrap" align="center">
      <Text fontSize="sm" fontWeight="medium" color="fg.muted">
        Workflows:
      </Text>
      {workflows.map((w) => (
        <Button
          key={w.id}
          size="sm"
          variant="outline"
          colorPalette={w.colorPalette ?? "green"}
          onClick={w.onClick}
        >
          {w.label}
        </Button>
      ))}
    </HStack>
  );
}
