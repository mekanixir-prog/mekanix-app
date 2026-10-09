import type { Metadata } from "next";
import { Vazirmatn } from "next/font/google";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/mek/theme-provider";
import { ServiceWorkerRegistrar } from "@/components/mek/service-worker-registrar";

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  display: "swap",
  variable: "--font-vazirmatn",
});

export const metadata: Metadata = {
  title: {
    default: "مکانیکس | تعمیر و نگهداری سیار خودرو و ماشین‌آلات سنگین در محل",
    template: "%s | مکانیکس",
  },
  description:
    "مکانیکس پلتفرم تعمیر و نگهداری سیار در ایران است. مکانیک‌های تأییدشده برای خودرو، کامیون، اتوبوس، بیل، لودر و ماشین‌آلات سنگین — عیب‌یابی، تعمیر و نگهداری در محل شما، با گارانتی ۶ ماهه و پرداخت امن.",
  keywords: [
    "مکانیک سیار", "تعمیرکار سیار", "تعمیر ماشین در محل", "تعمیر خودرو در محل",
    "مکانیک سنگین", "تعمیر ماشین‌آلات سنگین", "تعمیر بیل", "تعمیر لودر",
    "MEKANIX", "mobile mechanic", "on-site repair",
  ],
  manifest: "/manifest.json",
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: "/logo.webp", type: "image/webp" }, { url: "/logo.png", sizes: "any" }],
    apple: [{ url: "/logo.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "مکانیکس",
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
          {children}
          <Toaster />
          <SonnerToaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
