const nextConfig = {
  transpilePackages: ["@repo/tokens"],
  async rewrites() {
    if (!process.env.NEXT_PUBLIC_API_BASE_URL) return [];
    return [
      {
        source: "/hello",
        destination: `${process.env.NEXT_PUBLIC_API_BASE_URL}/hello`,
      },
      {
        source: "/healthz",
        destination: `${process.env.NEXT_PUBLIC_API_BASE_URL}/healthz`,
      },
    ];
  },
};
module.exports = nextConfig;
