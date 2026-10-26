import Link from "next/link";

type PublicServicePageProps = {
  eyebrow: string;
  title: string;
  intro: string;
  sections: Array<{ title: string; body: string; bullets?: string[] }>;
};

export function PublicServicePage({
  eyebrow,
  title,
  intro,
  sections,
}: PublicServicePageProps) {
  return (
    <main dir="rtl" lang="fa" className="min-h-screen bg-white text-zinc-900">
      <header className="border-b border-zinc-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5">
          <Link href="/" className="text-xl font-black tracking-tight" aria-label="صفحه اصلی مکانیکس">
            <span className="text-orange-600">مِکانیکس</span>
            <span className="mr-2 text-xs font-medium text-zinc-500">شبکه خدمات و تعمیرات</span>
          </Link>
          <Link href="/" className="rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-orange-700">
            ورود به سامانه
          </Link>
        </div>
      </header>

      <section className="border-b border-zinc-100 bg-gradient-to-bl from-orange-50 via-white to-white">
        <div className="mx-auto max-w-6xl px-5 py-16 md:py-24">
          <p className="mb-4 text-sm font-bold text-orange-700">{eyebrow}</p>
          <h1 className="max-w-4xl text-3xl font-black leading-tight tracking-tight md:text-5xl">{title}</h1>
          <p className="mt-6 max-w-3xl text-base leading-9 text-zinc-600 md:text-lg">{intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/" className="rounded-xl bg-orange-600 px-5 py-3 font-bold text-white hover:bg-orange-700">
              ورود و بررسی امکانات
            </Link>
            <Link href="/about" className="rounded-xl border border-zinc-300 px-5 py-3 font-bold text-zinc-800 hover:bg-white">
              آشنایی با مکانیکس
            </Link>
          </div>
          <p className="mt-4 max-w-3xl text-xs leading-6 text-zinc-500">
            جزئیات پوشش جغرافیایی، زمان‌بندی و امکان ارائه هر خدمت باید هنگام ثبت درخواست و بر اساس وضعیت واقعی سامانه تأیید شود.
          </p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-5 px-5 py-12 md:grid-cols-2">
        {sections.map((section) => (
          <article key={section.title} className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-xl font-extrabold">{section.title}</h2>
            <p className="mt-3 leading-8 text-zinc-600">{section.body}</p>
            {section.bullets && (
              <ul className="mt-4 list-inside list-disc space-y-2 leading-7 text-zinc-700">
                {section.bullets.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </article>
        ))}
      </section>

      <nav aria-label="صفحات مرتبط" className="mx-auto max-w-6xl px-5 pb-14">
        <h2 className="text-lg font-extrabold">مطالب مرتبط</h2>
        <div className="mt-4 flex flex-wrap gap-3 text-sm font-bold">
          <Link className="rounded-lg bg-zinc-100 px-4 py-3 hover:bg-zinc-200" href="/services/heavy-machinery">خدمات ماشین‌آلات سنگین</Link>
          <Link className="rounded-lg bg-zinc-100 px-4 py-3 hover:bg-zinc-200" href="/services/mobile-repair">تعمیرات سیار</Link>
          <Link className="rounded-lg bg-zinc-100 px-4 py-3 hover:bg-zinc-200" href="/about">درباره مکانیکس</Link>
        </div>
      </nav>

      <footer className="border-t border-zinc-200 bg-zinc-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-6 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>مکانیکس — سامانه خدمات و تعمیرات سیار</p>
          <p>اطلاعات خدمات و پوشش نهایی در زمان ثبت درخواست بررسی می‌شود.</p>
        </div>
      </footer>
    </main>
  );
}
