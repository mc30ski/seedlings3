/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@repo/tokens"],
  async rewrites() {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL;
    // Dev-only rewrites. In prod, apiBase is a RELATIVE path
    // (`/api/_proxy`) and every URL these rules would target is
    // already handled at the Vercel edge by vercel.json. Detecting a
    // full http(s) URL is the clean way to distinguish dev from prod
    // and keep the prod routing table untouched.
    const isFullUrl = !!apiBase && /^https?:\/\//i.test(apiBase);
    if (!isFullUrl) {
      return { beforeFiles: [], afterFiles: [], fallback: [] };
    }
    return {
      // beforeFiles runs BEFORE Next's own /api/* filesystem routes.
      // Forward every /api/... URL (except the local /api/_proxy
      // handler itself) directly to the dev API server. This mirrors
      // the prod Vercel rewrite `"/api/(.*)" → "/api/_proxy/$1"`, but
      // in dev we skip the proxy entirely — the proxy exists only to
      // inject the Vercel preview-protection bypass token, which dev
      // doesn't need. Without this rewrite, CTA URLs baked into promo
      // responses (shape `${baseUrl}/api/public/promotion/click/...`)
      // hit Next.js with no matching page and 404.
      beforeFiles: [
        {
          source: "/api/:path((?!_proxy).*)",
          destination: `${apiBase}/api/:path`,
        },
      ],
      afterFiles: [
        {
          source: "/hello",
          destination: `${apiBase}/api/hello`,
        },
        {
          source: "/healthz",
          destination: `${apiBase}/api/healthz`,
        },
        // Promo short URLs: /mo/<slug> and /mo/<slug>/<code>. Rewrite
        // both to the API's public route so the browser gets a 302 to
        // the resolved destination without ever seeing an /api/ path.
        // Vercel-side (prod) has the equivalent rewrite in vercel.json.
        {
          source: "/mo/:slug",
          destination: `${apiBase}/api/public/mo/:slug`,
        },
        {
          source: "/mo/:slug/:code",
          destination: `${apiBase}/api/public/mo/:slug/:code`,
        },
      ],
      fallback: [],
    };
  },
};
module.exports = nextConfig;
