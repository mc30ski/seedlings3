// Vanity URL dynamic route — handles seedlings.pro/<anything> that isn't
// a static page defined elsewhere in pages/. Static routes (sign-in,
// opt-out, pay, promotion/[slug], etc.) take precedence via Next.js's
// routing order.
//
// Behavior:
//   1. Hostname check — only serves on seedlings.pro. On seedlings.team
//      → 404. Consistent identity: .pro is the branded marketing surface.
//   2. Reserved slug check — even if a row somehow existed, block
//      well-known top-level paths (api, _next, favicon.ico, etc.)
//   3. Fetch VanityPage by slug via /public/vanity/:slug. The API
//      falls back to the default page automatically when the slug
//      doesn't exist; only returns 404 when no default is configured.
//   4. If kind=REDIRECT — return a Next.js redirect (302) from
//      getServerSideProps so the browser is bounced without ever
//      seeing the vanity URL in Loading state.
//   5. If kind=LANDING — server-render the page with proper OG tags
//      so link previews (iMessage, Facebook) show branded content.
//
// Bare domain (seedlings.pro/) is UNCHANGED — Next.js's own pages/index.tsx
// handles that. Vanity URLs only fire when the path has a segment
// after the domain.

import { GetServerSideProps } from "next";
import Head from "next/head";
import {
  Box,
  Button,
  Container,
  Heading,
  Text,
  VStack,
} from "@chakra-ui/react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

// Hostname allowlist — hardcoded here to match the API-side allowlist.
// Moves to a shared config source when Phase 2 of the promo multi-
// domain work introduces ALLOWED_DOMAINS as a Setting.
const VANITY_ALLOWED_HOSTS = new Set<string>(["seedlings.pro"]);

// Reserved slug guard — defense in depth so a mis-configured DB row
// or route regression can't accidentally serve a branded page over
// a route Next.js expects to own.
const RESERVED_SLUGS = new Set<string>([
  "sign-in",
  "opt-out",
  "pay",
  "promotion",
  "api",
  "mo",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "vanity",
  "admin",
  "super",
]);

type VanityPageData = {
  slug: string;
  kind: "LANDING" | "REDIRECT";
  title: string;
  headline: string;
  body: string;
  ctaText: string | null;
  ctaUrl: string | null;
  imageUrl: string | null;
  redirectUrl: string | null;
  isDefault: boolean;
};

type Props = {
  page: VanityPageData;
  // OG tags — extracted server-side so link previews get real content
  // even before the page fully hydrates.
  ogTitle: string;
  ogDescription: string;
  ogImage: string | null;
};

export default function VanityLandingPage({ page, ogTitle, ogDescription, ogImage }: Props) {
  return (
    <>
      <Head>
        <title>{ogTitle}</title>
        <meta name="description" content={ogDescription} />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={ogDescription} />
        <meta property="og:type" content="website" />
        {ogImage && <meta property="og:image" content={ogImage} />}
        <meta name="twitter:card" content={ogImage ? "summary_large_image" : "summary"} />
      </Head>
      <Box minH="100vh" bg="gray.50" py={{ base: 6, md: 12 }}>
        <Container maxW="2xl">
          <VStack align="stretch" gap={6}>
            {page.imageUrl && (
              <Box overflow="hidden" borderRadius="lg" borderWidth="1px" borderColor="gray.200" bg="white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={page.imageUrl}
                  alt={page.headline || page.slug}
                  style={{ width: "100%", height: "auto", display: "block" }}
                />
              </Box>
            )}
            <VStack align="stretch" gap={4} p={{ base: 4, md: 6 }} bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200">
              {page.headline && (
                <Heading size={{ base: "lg", md: "xl" }} color="fg.default">
                  {page.headline}
                </Heading>
              )}
              {page.body && (
                <Text
                  fontSize={{ base: "md", md: "lg" }}
                  color="fg.default"
                  whiteSpace="pre-wrap"
                  lineHeight="1.7"
                >
                  {page.body}
                </Text>
              )}
              {page.ctaText && page.ctaUrl && (
                <Box pt={2}>
                  <Button
                    as="a"
                    // Chakra's <Button as="a"> passes props through; href isn't in the type
                    // signature Chakra ships for the anchor variant.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    {...({ href: page.ctaUrl } as any)}
                    colorPalette="teal"
                    size="lg"
                  >
                    {page.ctaText}
                  </Button>
                </Box>
              )}
            </VStack>
          </VStack>
        </Container>
      </Box>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const rawSlug = String(ctx.params?.vanitySlug ?? "").toLowerCase();
  if (!rawSlug) return { notFound: true };

  // Reserved slug — should never reach here (Next.js routes take
  // precedence) but block defensively.
  if (RESERVED_SLUGS.has(rawSlug)) return { notFound: true };

  // Hostname check — .pro only in production. In dev we also accept
  // localhost / 127.0.0.1 so `npm run dev` "just works" without any
  // hosts-file setup. Same escape hatch the API-side check uses.
  const host = String(ctx.req.headers.host ?? "").toLowerCase().split(":")[0];
  const isDevHost = process.env.NODE_ENV !== "production" && (host === "localhost" || host === "127.0.0.1");
  if (!VANITY_ALLOWED_HOSTS.has(host) && !isDevHost) return { notFound: true };

  // Fetch from API. The API's public endpoint already handles fallback
  // to the default page — we only see a 404 when neither the requested
  // slug nor a default exists.
  //
  // Same URL shape the promotion landing page uses:
  //   • /api/ prefix is required (public routes are registered under
  //     the /api prefix on the Fastify side)
  //   • Falls back to `http://<request-host>` when NEXT_PUBLIC_API_BASE_URL
  //     isn't set (Vercel-side SSR calls itself via the same domain the
  //     visitor is on; the /api/ path then gets proxied through
  //     pages/api/_proxy/[...path].ts to the real API)
  const url = `${API_BASE || `http://${ctx.req.headers.host}`}/api/public/vanity/${encodeURIComponent(rawSlug)}`;
  let page: VanityPageData | null = null;
  try {
    const res = await fetch(url, {
      // Forward the request Host so the API's own hostname check sees
      // the actual domain the visitor is on, not the SSR fetcher's
      // outbound header.
      headers: { host, accept: "application/json" },
    });
    if (res.ok) {
      page = (await res.json()) as VanityPageData;
    }
  } catch {
    // Network hiccup between SSR fetcher and API — surface as 404
    // rather than a 500 (visitor sees a "not found" page instead of
    // a server error).
    return { notFound: true };
  }
  if (!page) return { notFound: true };

  // REDIRECT kind — bounce the browser via a proper server-side
  // redirect. Never renders the landing page shell.
  if (page.kind === "REDIRECT" && page.redirectUrl) {
    return {
      redirect: {
        destination: page.redirectUrl,
        // 307 preserves method (matches our .team-domain redirect
        // pattern) and is non-cacheable — operator can change the
        // target without stale browser caches.
        permanent: false,
      },
    };
  }

  // LANDING kind — render. Compute OG tags server-side.
  const ogTitle = page.title || page.headline || "Seedlings Lawn Care";
  const ogDescription =
    page.body?.trim().slice(0, 160) || "Serving the Triangle with trusted lawn care.";
  return {
    props: {
      page,
      ogTitle,
      ogDescription,
      ogImage: page.imageUrl,
    },
  };
};
