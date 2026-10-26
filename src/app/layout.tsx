import type { Metadata } from "next";
import { Vazirmatn } from "next/font/google";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/mek/theme-provider";
import { AccentThemeProvider } from "@/components/mek/accent-theme-provider";
import { ServiceWorkerRegistrar } from "@/components/mek/service-worker-registrar";

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  display: "swap",
  variable: "--font-vazirmatn",
});

const siteName = "مکانیکس";
const siteDescription =
  "مکانیکس سامانه‌ای برای ثبت و پیگیری درخواست‌های تعمیر و نگهداری خودرو و ماشین‌آلات سنگین است؛ اطلاعات وسیله و شرح ایراد را ثبت کنید و امکان ارائه خدمت را در سامانه بررسی کنید.";

export const metadata: Metadata = {
  metadataBase: new URL("https://mekanix.ir"),
  title: {
    default: "مکانیکس | تعمیر و نگهداری سیار خودرو و ماشین‌آلات سنگین",
    template: "%s | مکانیکس",
  },
  description: siteDescription,
  applicationName: siteName,
  category: "business",
  keywords: [
    "مکانیک سیار",
    "تعمیرکار سیار",
    "تعمیر خودرو در محل",
    "تعمیر ماشین‌آلات سنگین",
    "تعمیر بیل مکانیکی",
    "تعمیر لودر",
    "سرویس ماشین‌آلات راه‌سازی",
    "MEKANIX",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "fa_IR",
    siteName,
    title: "مکانیکس | ثبت و پیگیری خدمات تعمیر و نگهداری",
    description: siteDescription,
    url: "https://mekanix.ir",
    images: [{ url: "/logo.webp", alt: "نشان مکانیکس" }],
  },
  twitter: {
    card: "summary",
    title: "مکانیکس | تعمیر و نگهداری سیار",
    description: siteDescription,
    images: ["/logo.webp"],
  },
  manifest: "/manifest.json",
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: "/logo.webp", type: "image/webp" }, { url: "/logo.png", sizes: "any" }],
    apple: [{ url: "/logo.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: siteName,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <body className={`${vazirmatn.variable} font-sans antialiased bg-background text-foreground`}>
        <ServiceWorkerRegistrar />
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <AccentThemeProvider>
            {children}
            <Toaster />
            <SonnerToaster position="top-right" richColors closeButton />
          </AccentThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
