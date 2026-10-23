import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// MEKANIX — OpenNext (Cloudflare Workers) build configuration
//
// WHY a custom buildCommand?
//   OpenNext's build flow calls `buildNextjsApp()` from @opennextjs/aws, which
//   reads `config.buildCommand` (top-level) and runs it. By default that
//   resolves to `bun run build` / `npm run build`.
//
//   Our package.json `build` script is:
//     "next build && node -e \"mkdir .next/standalone/.next + cpSync static + cpSync public\""
//
//   The trailing `node -e` step is needed by the STANDARD Node/Docker
//   standalone server, but it is HARMFUL during the Cloudflare build:
//     - It copies static assets into `.next/standalone/...` which OpenNext
//       does not use (OpenNext has its own asset pipeline).
//     - On Windows it can fail with EPERM/ENOENT inside `.next/standalone`
//       when the worker config has no `output: "standalone"` in source
//       (OpenNext sets NEXT_PRIVATE_STANDALONE=true at runtime instead),
//       leaving `.next/server/middleware-manifest.json` unwritten and the
//       OpenNext bundle step crashes with "cannot read middleware-manifest.json".
//
//   This custom buildCommand runs `bunx next build` ALONE (no post-build
//   node -e), which is all OpenNext actually needs. OpenNext itself sets
//   NEXT_PRIVATE_STANDALONE=true via setStandaloneBuildMode() right before
//   invoking this command, so the Next build still produces the standalone
//   trace + server manifests that OpenNext consumes.
//
//   This is the cross-platform, repeatable fix for the Windows OpenNext
//   build failure. No node_modules patching required.
//
// NOTE: `defineCloudflareConfig` only accepts `CloudflareOverrides`
// (incrementalCache, tagCache, queue, etc.) — NOT top-level options like
// `buildCommand`. So we spread its result and add `buildCommand` at the
// top level, which is where `buildNextApp.js` reads it from.
const cloudflareConfig = defineCloudflareConfig({
  // D1 database binding name (must match wrangler.toml [d1_databases] binding).
  // Accessed via env.DB in Workers runtime.
});

export default {
  ...cloudflareConfig,
  // Override the default `bun run build` (which includes the harmful
  // post-build asset copy) with a plain `next build`. OpenNext sets
  // NEXT_PRIVATE_STANDALONE=true before invoking this, so standalone
  // tracing + middleware-manifest.json are still produced.
  buildCommand: "bunx next build",
};
