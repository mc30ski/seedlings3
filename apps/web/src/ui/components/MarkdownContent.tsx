"use client";

import { Box, Heading, Text, Link, Code } from "@chakra-ui/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * react-markdown sanitizes hrefs and blanks any scheme outside
 * http/https/mailto/tel — which silently turns `guide:<slug>` into an
 * empty href long before `linkRenderer` ever sees it.
 *
 * This lets that ONE extra scheme through, matched narrowly, and defers
 * everything else to the library's own transform so `javascript:` and
 * friends stay blocked. The href is never used as a real URL: the guide
 * renderer intercepts it and navigates in-app.
 */
const GUIDE_SCHEME = /^guide:[a-z0-9][a-z0-9-]*$/i;
function urlTransform(value: string): string {
  if (GUIDE_SCHEME.test(value)) return value;
  return defaultUrlTransform(value);
}

/**
 * Renders markdown content with Chakra-native styling.
 *
 * Chakra v3's CSS reset strips native heading sizes, list bullets, and
 * paragraph margins — so a bare `<ReactMarkdown>` output ends up looking
 * like plain flowed text. This component maps each markdown element to a
 * Chakra component (or styled `Box`) so the output looks like a real
 * document.
 *
 * Shared by every surface that renders operator-authored markdown:
 * the worker sign wizard, the admin policy preview, the client-facing
 * invoice promo block, and the promotion editor's previews. Extend the
 * components map HERE rather than in any callsite, so what an operator
 * previews is byte-for-byte what a client sees.
 *
 * (Renamed from PolicyMarkdown 2026-08-22 — it outgrew policies.)
 */
export default function MarkdownContent({
  children,
  linkRenderer,
}: {
  children: string;
  /** Optional per-link override. Return a node to render it yourself, or
   *  null/undefined to fall through to the default external link. Guides
   *  use this for in-app `guide:<slug>` cross-references; every other
   *  caller leaves it unset and gets the plain behaviour. */
  linkRenderer?: (args: { href?: string; children: React.ReactNode }) => React.ReactNode | null;
}) {
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

        // GFM tables. Chakra v3's reset zeroes border-collapse and cell
        // padding, so an unstyled table renders as run-together text —
        // "Apr–MayFirst feed once fully green" — which reads as a broken
        // page, not as a table. Styled here rather than via a `components`
        // override so nested tables and the `<tr>`/`<th>` elements
        // react-markdown emits are all covered by one rule.
        //
        // The wrapper scrolls on its own so a wide table cannot push the
        // page into horizontal scroll on a phone, which is where most of
        // this content is read.
        "& table": {
          display: "block",
          overflowX: "auto",
          width: "100%",
          borderCollapse: "collapse",
          marginBottom: "0.75rem",
          fontSize: "0.8125rem",
        },
        "& th, & td": {
          border: "1px solid var(--chakra-colors-gray-200)",
          padding: "0.375rem 0.625rem",
          textAlign: "left",
          verticalAlign: "top",
        },
        "& th": {
          backgroundColor: "var(--chakra-colors-gray-50)",
          fontWeight: 600,
          whiteSpace: "nowrap",
        },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
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
          a: ({ href, children: c }) => {
            const custom = linkRenderer?.({ href, children: c });
            if (custom) return <>{custom}</>;
            return (
              <Link
                href={href}
                target="_blank"
                rel="noreferrer"
                color="blue.600"
                textDecoration="underline"
              >
                {c}
              </Link>
            );
          },
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
