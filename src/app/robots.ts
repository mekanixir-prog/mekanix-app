import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/about", "/services/"],
        disallow: ["/api/", "/admin/", "/admin-panel/", "/clear-sw/"],
      },
    ],
    sitemap: "https://mekanix.ir/sitemap.xml",
    host: "https://mekanix.ir",
  };
}
