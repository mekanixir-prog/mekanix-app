import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "درباره مکانیکس",
  description: "مکانیکس با هدف سامان‌دهی ثبت و پیگیری درخواست‌های تعمیر و نگهداری خودرو و ماشین‌آلات، اطلاعات وسیله و فرایند خدمات را در یک مسیر متمرکز قرار می‌دهد.",
  alternates: { canonical: "/about" },
  openGraph: {
    type: "website",
    locale: "fa_IR",
    title: "درباره مکانیکس",
    description: "آشنایی با هدف و مسیر خدمات مکانیکس برای خودرو و ماشین‌آلات سنگین.",
    url: "/about",
    siteName: "مکانیکس",
  },
};

export default function AboutPage() {
  return (
    <main lang="fa" dir="rtl" className="min-h-screen bg-white text-zinc-900">
      <header className="border-b border-zinc-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
          <Link href="/" className="text-xl font-black text-orange-600">مکانیکس</Link>
          <Link href="/" className="rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-bold text-white">ورود به سامانه</Link>
        </div>
      </header>
      <article className="mx-auto max-w-4xl px-5 py-16 md:py-24">
        <p className="font-bold text-orange-700">درباره ما</p>
        <h1 className="mt-4 text-3xl font-black leading-tight md:text-5xl">مکانیکس؛ مسیر متمرکز برای ثبت و پیگیری خدمات تعمیر و نگهداری</h1>
        <p className="mt-7 text-lg leading-9 text-zinc-600">
          مکانیکس با هدف ساده‌تر کردن فرایند درخواست خدمات برای خودرو و ماشین‌آلات سنگین توسعه داده می‌شود. ایده اصلی، ثبت مشخصات وسیله، توضیح روشن ایراد و امکان پیگیری وضعیت درخواست در یک مسیر مشخص است.
        </p>
        <section className="mt-12 grid gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="text-xl font-extrabold">تمرکز بر اطلاعات درست</h2>
            <p className="mt-3 leading-8 text-zinc-600">ثبت مدل وسیله، نشانه‌های خرابی و محل استقرار، اطلاعات اولیه را برای بررسی درخواست منظم‌تر می‌کند.</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="text-xl font-extrabold">پیگیری شفاف‌تر</h2>
            <p className="mt-3 leading-8 text-zinc-600">هدف سامانه این است که اطلاعات درخواست و تغییر وضعیت آن در مسیر خدمات قابل پیگیری باشد؛ جزئیات در دسترس به وضعیت واقعی محصول بستگی دارد.</p>
          </div>
        </section>
        <section className="mt-12 rounded-2xl bg-orange-50 p-6 md:p-8">
          <h2 className="text-xl font-extrabold">آشنایی با خدمات</h2>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link className="rounded-xl bg-white px-4 py-3 font-bold text-orange-700 ring-1 ring-orange-200" href="/services/heavy-machinery">تعمیر و نگهداری ماشین‌آلات سنگین</Link>
            <Link className="rounded-xl bg-white px-4 py-3 font-bold text-orange-700 ring-1 ring-orange-200" href="/services/mobile-repair">تعمیرکار سیار و تعمیر در محل</Link>
          </div>
        </section>
        <p className="mt-8 text-sm leading-7 text-zinc-500">مکانیکس پیش از ارائه هر خدمت باید امکان پوشش محل، ظرفیت متخصص و جزئیات درخواست را تأیید کند. این صفحه وعده ارائه فوری یا سراسری خدمت نمی‌دهد.</p>
      </article>
      <footer className="border-t border-zinc-200 bg-zinc-50 px-5 py-6 text-center text-sm text-zinc-500">مکانیکس — خدمات و تعمیرات سیار</footer>
    </main>
  );
}
