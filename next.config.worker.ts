// MEKANIX — Next.js config for Cloudflare Workers
//
// This config is used ONLY when building for Cloudflare Workers.
// The normal Node.js/Docker build uses next.config.ts (also standalone, but
// with the post-build asset copy for the standalone server.js).
//
// To build for Workers:
//   bun scripts/build-cloudflare.mjs   (cross-platform — recommended)
//   bash scripts/build-cloudflare.sh   (Linux/macOS only)
//   Or manually:
//     NEXT_PRIVATE_STANDALONE=1 bunx next build
//     bunx opennextjs-cloudflare build

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OpenNext consumes the Next.js standalone build output, so we keep
  // `output: "standalone"`. OpenNext also sets NEXT_PRIVATE_STANDALONE=true
  // at runtime via setStandaloneBuildMode(), but declaring it explicitly
  // here is safer (defense in depth) and makes the config self-documenting.
  // This also ensures .next/server/middleware-manifest.json is produced,
  // which OpenNext's loadMiddlewareManifest() reads — without it the
  // bundle step crashes with "cannot read middleware-manifest.json".
  output: "standalone",
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai"],
  // Required for Prisma + OpenNext + Cloudflare Workers (per OpenNext docs):
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
