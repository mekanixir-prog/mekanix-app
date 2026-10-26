import type { MetadataRoute } from "next";

const siteUrl = "https://mekanix.ir";

export default function sitemap(): MetadataRoute.Sitemap {
  // Do not set lastModified to the build time. That would falsely imply every
  // URL's content changed on every deployment. Add per-page dates only when
  // they can be sourced from actual content updates.
  return [
    {
      url: siteUrl,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/about`,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${siteUrl}/services/heavy-machinery`,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${siteUrl}/services/mobile-repair`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
