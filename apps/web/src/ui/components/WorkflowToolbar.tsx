"use client";

import { Button, HStack } from "@chakra-ui/react";

export type WorkflowDef = {
  id: string;
  label: string;
  colorPalette?: string;
  /** Override default shade numbers: [bg, text, border, hoverBg] e.g. [50, 600, 300, 100] */
  shades?: [number, number, number, number];
  onClick: () => void;
};

type Props = {
  workflows: WorkflowDef[];
};

export default function WorkflowToolbar({ workflows }: Props) {
  if (workflows.length === 0) return null;

  return (
    <HStack gap={2} mb={3} ml={4} wrap="wrap" align="center">
      {workflows.map((w) => {
        const c = w.colorPalette ?? "green";
        const [bg, text, border, hover] = w.shades ?? [100, 800, 400, 200];
        return (
        <Button
          key={w.id}
          size="sm"
          variant="solid"
          css={{
            background: `var(--chakra-colors-${c}-${bg})`,
            color: `var(--chakra-colors-${c}-${text})`,
            border: `1px solid var(--chakra-colors-${c}-${border})`,
            "&:hover": {
              background: `var(--chakra-colors-${c}-${hover})`,
            },
          }}
          onClick={w.onClick}
        >
          {w.label}
        </Button>
        );
      })}
    </HStack>
  );
}
