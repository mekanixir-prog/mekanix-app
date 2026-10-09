import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai"],
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
