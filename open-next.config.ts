import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // D1 database binding name (must match wrangler.toml)
  // The D1 binding is accessed via env.DB in Workers
});
