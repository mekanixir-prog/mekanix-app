import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai"],
  // Mark this app as having completed the agent-driven security upgrade
  // (Next.js 16.4.0 → 16.4.3). Required by `next upgrade --agent=security`.
  experimental: {
    agentUpgrade: "security" as const,
  },
  ...(isProduction
    ? {
        async rewrites() {
          return [
            {
              source: "/api/auth/demo",
              destination: "/404",
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
