// Promotion landing page, short form: /motion/<slug>.
//
// WHY THIS FILE EXISTS
// On the marketing domain the address completes the word:
//
//     seedlings.pro/motion/fall-cleanup   ->  "pro-motion"
//
// Every other host keeps the long /promotion/<slug> form, which is what
// `buildLandingPageUrl` in apps/api/src/services/promotions.ts decides.
//
// WHY A PAGE AND NOT A REWRITE
// The obvious implementation is a rewrite `/motion/(.*)` -> `/promotion/$1`.
// It is the wrong one here. Rewrites live in TWO places that must agree —
// apps/web/vercel.json (production) and apps/web/next.config.js (dev) — and
// on 2026-08-23 those two silently disagreed: every promotion click URL
// worked in dev and 404'd in production, for months, because the prod rule
// dropped a path segment its dev counterpart kept. Both files even carried
// comments claiming they mirrored each other.
//
// A real page file cannot drift like that. Next.js resolves it from the
// filesystem identically in dev, preview, and production, with no config to
// keep in sync and nothing to forget.
//
// BOTH ROUTES ARE PERMANENT
// /promotion/<slug> stays forever — it is in customer inboxes, SMS threads,
// and link previews already sent. This adds an address; it retires nothing.
//
// The page, its data fetching, and its OG tags all come from the canonical
// implementation. The dynamic segment is named identically
// ([promotionSlug]) so getServerSideProps reads ctx.params the same way.
export { default, getServerSideProps } from "../promotion/[promotionSlug]";
