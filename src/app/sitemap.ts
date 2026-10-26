import type { MetadataRoute } from "next";

const siteUrl = "https://mekanix.ir";

export default function sitemap(): MetadataRoute.Sitemap {
  const updatedAt = new Date();

  return [
    {
      url: siteUrl,
      lastModified: updatedAt,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/about`,
      lastModified: updatedAt,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${siteUrl}/services/heavy-machinery`,
      lastModified: updatedAt,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${siteUrl}/services/mobile-repair`,
      lastModified: updatedAt,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
