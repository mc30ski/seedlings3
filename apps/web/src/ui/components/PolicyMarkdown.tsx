"use client";

import { Box, Heading, Text, Link, Code } from "@chakra-ui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders policy markdown content with Chakra-native styling.
 *
 * Chakra v3's CSS reset strips native heading sizes, list bullets, and
 * paragraph margins — so a bare `<ReactMarkdown>` output ends up looking
 * like plain flowed text. This component maps each markdown element to a
 * Chakra component (or styled `Box`) so the output looks like a real
 * document.
 *
 * Used by both the worker sign wizard (PolicySignWizard) and the admin
 * preview dialog (VersionPreviewDialog) so the two surfaces render
 * identically. Extend the components map here rather than in either
 * callsite.
 */
export default function PolicyMarkdown({ children }: { children: string }) {
  return (
    <Box
      fontSize="sm"
      lineHeight="1.6"
      color="fg.default"
      // Extra spacing for elements react-markdown injects that we didn't
      // explicitly override (tables, hr, etc.). Chakra's typography scale.
      css={{
        "& > *:first-of-type": { marginTop: 0 },
        "& > *:last-of-type": { marginBottom: 0 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children: c }) => (
            <Heading as="h1" size="lg" mt={4} mb={2}>
              {c}
            </Heading>
          ),
          h2: ({ children: c }) => (
            <Heading as="h2" size="md" mt={4} mb={2}>
              {c}
            </Heading>
          ),
          h3: ({ children: c }) => (
            <Heading as="h3" size="sm" mt={3} mb={2}>
              {c}
            </Heading>
          ),
          h4: ({ children: c }) => (
            <Heading as="h4" size="xs" mt={3} mb={1}>
              {c}
            </Heading>
          ),
          p: ({ children: c }) => (
            <Text mb={2}>{c}</Text>
          ),
          strong: ({ children: c }) => (
            <Text as="strong" fontWeight="bold">
              {c}
            </Text>
          ),
          em: ({ children: c }) => (
            <Text as="em" fontStyle="italic">
              {c}
            </Text>
          ),
          ul: ({ children: c }) => (
            <Box as="ul" pl={5} mb={2} style={{ listStyleType: "disc" }}>
              {c}
            </Box>
          ),
          ol: ({ children: c }) => (
            <Box as="ol" pl={5} mb={2} style={{ listStyleType: "decimal" }}>
              {c}
            </Box>
          ),
          li: ({ children: c }) => (
            <Box as="li" mb={1}>
              {c}
            </Box>
          ),
          a: ({ href, children: c }) => (
            <Link
              href={href}
              target="_blank"
              rel="noreferrer"
              color="blue.600"
              textDecoration="underline"
            >
              {c}
            </Link>
          ),
          code: ({ children: c }) => (
            <Code fontSize="xs" px={1}>
              {c}
            </Code>
          ),
          pre: ({ children: c }) => (
            <Box
              as="pre"
              p={2}
              bg="gray.100"
              borderRadius="md"
              overflowX="auto"
              fontSize="xs"
              fontFamily="mono"
              mb={2}
            >
              {c}
            </Box>
          ),
          blockquote: ({ children: c }) => (
            <Box
              as="blockquote"
              pl={3}
              borderLeftWidth="3px"
              borderLeftColor="gray.300"
              color="fg.muted"
              mb={2}
            >
              {c}
            </Box>
          ),
          hr: () => (
            <Box as="hr" my={3} borderTopWidth="1px" borderColor="gray.200" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}
