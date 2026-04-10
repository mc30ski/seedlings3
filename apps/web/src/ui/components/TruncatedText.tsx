"use client";

import { useRef, useState, useEffect } from "react";
import { Box, Text } from "@chakra-ui/react";

type Props = {
  children: string;
  maxLines?: number;
  fontSize?: string;
  color?: string;
  fontWeight?: string;
  whiteSpace?: string;
};

export default function TruncatedText({
  children,
  maxLines = 2,
  fontSize = "xs",
  color = "fg.muted",
  fontWeight,
  whiteSpace,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [isClamped, setIsClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !expanded) {
      setIsClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, [children, expanded, maxLines]);

  if (!children) return null;

  if (expanded) {
    return (
      <Box>
        <Text
          fontSize={fontSize}
          color={color}
          fontWeight={fontWeight}
          whiteSpace={whiteSpace ?? "pre-wrap"}
        >
          {children}
        </Text>
        <Text
          as="span"
          color="blue.500"
          fontSize={fontSize}
          fontWeight="medium"
          cursor="pointer"
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        >
          Show less
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text
        ref={ref}
        fontSize={fontSize}
        color={color}
        fontWeight={fontWeight}
        css={{
          display: "-webkit-box",
          WebkitLineClamp: maxLines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: whiteSpace ?? "pre-wrap",
        }}
      >
        {children}
      </Text>
      {isClamped && (
        <Text
          as="span"
          color="blue.500"
          fontSize={fontSize}
          fontWeight="medium"
          cursor="pointer"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        >
          Show more
        </Text>
      )}
    </Box>
  );
}
