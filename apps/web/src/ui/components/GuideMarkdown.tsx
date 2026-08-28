"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GuideMarkdown — the education-guide renderer.
//
// Canonical spec: docs/features/education.md
//
// Wraps the shared MarkdownContent (so a guide looks like every other
// operator-authored document in the app) and adds the two things guides
// need that nothing else does:
//
//   1. IN-APP MEDIA. `![alt](guide-asset:<id>)` resolves to a short-lived
//      signed URL at RENDER time. The markdown never stores a URL, so a
//      link cannot expire inside approved content, and "which guides use
//      this asset?" is a string search rather than an HTML parse.
//
//   2. VIDEO, without enabling raw HTML. Markdown has no video syntax, and
//      turning on `rehype-raw` to get an <iframe> would reopen XSS for
//      every Admin author. Instead a line of the form
//
//          :::video <url-or-guide-asset:id>
//
//      is lifted out BEFORE the markdown is parsed and rendered as a real
//      player. External URLs render only when their host is on the
//      GUIDE_ALLOWED_EMBED_DOMAINS allowlist; anything else degrades to a
//      plain link rather than silently embedding a stranger's page.
//
//   3. CROSS-REFERENCES. `[text](guide:<slug>)` navigates WITHIN the app
//      instead of opening a tab, and resolves the target's current title
//      so re-titling a guide cannot rot the link text.
//
//      Resolution is scoped by the reader's own visibility. A published
//      guide may link to one still in draft; a worker must not learn that
//      the draft exists, so an unresolvable target degrades to the plain
//      label with no hint that anything is hidden. Authors instead see it
//      flagged as not yet published, which is the point at which it can
//      still be fixed.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { Box, Link, Text } from "@chakra-ui/react";
import MarkdownContent from "@/src/ui/components/MarkdownContent";
import { apiGet } from "@/src/lib/api";
import { resolveGuideLinks, type GuideLinkTarget } from "@/src/lib/guides";

const ASSET_RE = /guide-asset:([a-z0-9]+)/gi;
// Slugs are generated lower-kebab, so this stays deliberately narrow — a
// stray "guide:" in prose does not become a link.
const GUIDE_LINK_RE = /guide:([a-z0-9][a-z0-9-]*)/gi;
const VIDEO_LINE_RE = /^:::video\s+(\S+)\s*$/gim;

/** Resolve `guide-asset:<id>` tokens to signed URLs, once per id. */
function useAssetUrls(markdown: string): Record<string, string> {
  const ids = useMemo(() => {
    const found = new Set<string>();
    for (const m of markdown.matchAll(ASSET_RE)) found.add(m[1]);
    return [...found];
  }, [markdown]);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await apiGet<{ url: string }>(`/api/me/guides/assets/${id}/url`);
            return [id, r.url] as const;
          } catch {
            // A missing asset must not take the whole page down — the rest
            // of the guide is still worth reading.
            return [id, ""] as const;
          }
        }),
      );
      if (!cancelled) setUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [ids.join(",")]);

  return urls;
}

/** Resolve `guide:<slug>` tokens to their targets, once per slug. */
function useGuideLinks(markdown: string): { bySlug: Record<string, GuideLinkTarget>; loaded: boolean } {
  const slugs = useMemo(() => {
    const found = new Set<string>();
    for (const m of markdown.matchAll(GUIDE_LINK_RE)) found.add(m[1].toLowerCase());
    return [...found];
  }, [markdown]);
  const [bySlug, setBySlug] = useState<Record<string, GuideLinkTarget>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (slugs.length === 0) {
      setBySlug({});
      setLoaded(true);
      return;
    }
    setLoaded(false);
    (async () => {
      try {
        const rows = await resolveGuideLinks(slugs);
        if (!cancelled) setBySlug(Object.fromEntries(rows.map((r) => [r.slug, r])));
      } catch {
        // A failed lookup degrades every link to plain text, which is the
        // same outcome as a target the reader may not see — no worse than
        // the pre-token behaviour, and it never breaks the page.
        if (!cancelled) setBySlug({});
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slugs.join(",")]);

  return { bySlug, loaded };
}

/**
 * Is this something we are willing to put in an href?
 *
 * The `:::video` line is lifted out BEFORE react-markdown parses, which
 * means the library's `urlTransform` — the thing that blanks
 * `javascript:` and friends on every ordinary link — never sees it. A
 * target that is not on the embed allowlist falls through to a plain
 * link, and without this check that link rendered the raw target
 * verbatim: `:::video javascript:alert(1)` produced a working
 * javascript: href on a page every worker can open.
 *
 * Authoring is Admin-gated and publishing needs a Super, so this is not
 * open to the world — but it routes around the one sanitizer this
 * renderer relies on, and an approver reading prose is not going to
 * catch it.
 */
function isSafeHref(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    // Not absolute — relative targets are not meaningful for an embed.
    return false;
  }
}

/** youtube/vimeo → embeddable player URL; anything else → null. */
function embedUrlFor(raw: string, allowedDomains: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!allowedDomains.includes(u.hostname)) return null;

  if (u.hostname.endsWith("youtube.com")) {
    const v = u.searchParams.get("v");
    // youtube-nocookie: the guide is internal training, so there is no
    // reason to hand a worker's viewing habits to an ad network.
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (u.hostname === "youtu.be") {
    const id = u.pathname.replace(/^\//, "");
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (u.hostname.endsWith("vimeo.com")) {
    const id = u.pathname.split("/").filter(Boolean).pop();
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
}

function VideoBlock({
  target,
  assetUrls,
  allowedDomains,
}: {
  target: string;
  assetUrls: Record<string, string>;
  allowedDomains: string[];
}) {
  const assetMatch = /^guide-asset:([a-z0-9]+)$/i.exec(target);

  if (assetMatch) {
    const url = assetUrls[assetMatch[1]];
    if (!url) return <Text fontSize="xs" color="fg.muted">Loading video…</Text>;
    return (
      <Box my={3} borderRadius="md" overflow="hidden" borderWidth="1px" borderColor="gray.200">
        <video
          src={url}
          controls
          preload="metadata"
          style={{ width: "100%", display: "block", maxHeight: "70vh", background: "black" }}
        />
      </Box>
    );
  }

  const embed = embedUrlFor(target, allowedDomains);
  if (!embed) {
    // Not a usable scheme — render the text, never a link. See isSafeHref.
    if (!isSafeHref(target)) {
      return (
        <Box my={3}>
          <Text fontSize="sm" color="fg.muted" wordBreak="break-all">
            {target}
          </Text>
          <Text fontSize="2xs" color="red.600">
            Not a valid video link.
          </Text>
        </Box>
      );
    }
    // Not on the allowlist. A plain link is the honest fallback — silently
    // embedding an arbitrary host would put a third party inside training
    // material that a Super approved.
    return (
      <Box my={3}>
        <Link href={target} target="_blank" rel="noreferrer" color="blue.600" textDecoration="underline">
          {target}
        </Link>
        <Text fontSize="2xs" color="fg.muted">
          Opens outside the app — this host isn&apos;t on the embed allowlist.
        </Text>
      </Box>
    );
  }

  return (
    <Box
      my={3}
      position="relative"
      pt="56.25%"
      borderRadius="md"
      overflow="hidden"
      borderWidth="1px"
      borderColor="gray.200"
    >
      <iframe
        src={embed}
        title="Embedded video"
        allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
      />
    </Box>
  );
}

export default function GuideMarkdown({
  children,
  allowedEmbedDomains = [],
  onOpenGuide,
  showUnpublishedLinkState = false,
}: {
  children: string;
  allowedEmbedDomains?: string[];
  /** Navigate to another guide in place. Omit in contexts with nowhere to
   *  go (a preview inside a dialog) and links render as plain text. */
  onOpenGuide?: (slug: string) => void;
  /** Author surfaces only: mark links whose target is not published yet.
   *  MUST stay false on worker surfaces — it would reveal that a hidden
   *  guide exists behind a link the author wrote. */
  showUnpublishedLinkState?: boolean;
}) {
  const assetUrls = useAssetUrls(children);
  const { bySlug, loaded: linksLoaded } = useGuideLinks(children);

  const linkRenderer = useMemo(
    () =>
      ({ href, children: label }: { href?: string; children: React.ReactNode }) => {
        const m = /^guide:([a-z0-9][a-z0-9-]*)$/i.exec(href ?? "");
        if (!m) return null; // not a cross-reference — default handling
        const slug = m[1].toLowerCase();
        const target = bySlug[slug];

        // Unresolved: either the slug is wrong, or it names something this
        // reader may not see. Both render as plain text — a worker must
        // not be able to tell the two apart.
        if (!target) {
          if (!linksLoaded) return <Text as="span">{label}</Text>;
          return (
            <Text as="span" title={showUnpublishedLinkState ? "No guide with that link" : undefined}>
              {label}
              {showUnpublishedLinkState && (
                <Text as="span" fontSize="2xs" color="red.500" ml={1}>
                  (broken link)
                </Text>
              )}
            </Text>
          );
        }

        return (
          <Text
            as="span"
            role={onOpenGuide ? "link" : undefined}
            tabIndex={onOpenGuide ? 0 : undefined}
            color="blue.600"
            textDecoration="underline"
            cursor={onOpenGuide ? "pointer" : "default"}
            onClick={onOpenGuide ? () => onOpenGuide(slug) : undefined}
            onKeyDown={
              onOpenGuide
                ? (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenGuide(slug);
                    }
                  }
                : undefined
            }
          >
            {label}
            {showUnpublishedLinkState && !target.isPublished && (
              <Text as="span" fontSize="2xs" color="orange.600" ml={1}>
                (not published)
              </Text>
            )}
          </Text>
        );
      },
    [bySlug, linksLoaded, onOpenGuide, showUnpublishedLinkState],
  );

  // Split on :::video lines, so each becomes a real element between two
  // runs of ordinary markdown. Done here rather than via a remark plugin
  // to keep raw HTML disabled — the whole point of the directive.
  const blocks = useMemo(() => {
    const out: Array<{ kind: "md"; text: string } | { kind: "video"; target: string }> = [];
    let last = 0;
    for (const m of children.matchAll(VIDEO_LINE_RE)) {
      const before = children.slice(last, m.index);
      if (before.trim()) out.push({ kind: "md", text: before });
      out.push({ kind: "video", target: m[1] });
      last = (m.index ?? 0) + m[0].length;
    }
    const tail = children.slice(last);
    if (tail.trim()) out.push({ kind: "md", text: tail });
    return out;
  }, [children]);

  return (
    <Box>
      {blocks.map((b, i) =>
        b.kind === "video" ? (
          <VideoBlock
            key={i}
            target={b.target}
            assetUrls={assetUrls}
            allowedDomains={allowedEmbedDomains}
          />
        ) : (
          <MarkdownContent key={i} linkRenderer={linkRenderer}>
            {/* Swap asset tokens for signed URLs just before rendering. An
                unresolved token renders as-is rather than as a broken
                image, which reads as "still loading" instead of "gone". */}
            {b.text.replace(ASSET_RE, (whole, id: string) => assetUrls[id] || whole)}
          </MarkdownContent>
        ),
      )}
    </Box>
  );
}
