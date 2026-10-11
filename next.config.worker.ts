// MEKANIX — Next.js config for Cloudflare Workers
//
// This config is used ONLY when building for Cloudflare Workers.
// The normal Node.js/Docker build uses next.config.ts (with output: "standalone").
//
// To build for Workers:
//   NEXT_WORKER_BUILD=1 bunx next build
//   bunx opennextjs-cloudflare build
//
// Or use: bash scripts/build-cloudflare.sh (handles everything)

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NO output: "standalone" — OpenNext uses its own build output
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai"],
  // Required for Prisma + OpenNext + Cloudflare Workers (per OpenNext docs):
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
