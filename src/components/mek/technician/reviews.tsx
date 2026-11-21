"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Star, Loader2 } from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { api, type Technician } from "@/lib/api";
import { SectionHeader, EmptyState, StarRating } from "@/components/mek/shared/primitives";
import { fmtRelative, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";

export function TechnicianReviews({ user }: { user: DemoUser }) {
  const { t, isFa } = useT();
  const [tech, setTech] = useState<Technician | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user.technician) return;
    api.getTechnician(user.technician.id).then(setTech).finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  const reviews = (tech as any)?.reviews ?? [];

  const avg = tech?.rating != null ? Number(tech.rating) : 0;
  const dist = [5, 4, 3, 2, 1].map((star) => {
    const count = reviews.filter((r: any) => r.rating === star).length;
    return { star, count, pct: reviews.length ? (count / reviews.length) * 100 : 0 };
  });

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("tech.reviews.title")} subtitle={t("tech.reviews.subtitle")} />

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <div className="rounded-xl border border-border bg-card p-5 text-center">
          <p className="font-display text-5xl font-bold text-amber">{isFa ? toPersianDigits(avg.toFixed(1)) : avg.toFixed(1)}</p>
          <div className="mt-2 flex justify-center"><StarRating value={avg} size={18} /></div>
          <p className="mt-1 text-xs text-muted-foreground">{isFa ? toPersianDigits(tech?.reviewCount ?? 0) : (tech?.reviewCount ?? 0)} {t("common.reviews")}</p>
          <div className="mt-4 space-y-1.5">
            {dist.map((d) => (
              <div key={d.star} className="flex items-center gap-2 text-[11px]">
                <span className="flex w-8 items-center gap-0.5"><Star className="size-3 fill-amber text-amber" />{isFa ? toPersianDigits(d.star) : d.star}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-amber" style={{ width: `${d.pct}%` }} />
                </div>
                <span className="w-6 text-right text-muted-foreground">{isFa ? toPersianDigits(d.count) : d.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {reviews.length === 0 ? (
            <EmptyState icon={Star} title={t("tech.reviews.empty")} description={t("tech.reviews.emptyDesc")} />
          ) : (
            reviews.map((r: any, i: number) => (
              <motion.div
                key={r.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="rounded-xl border border-border bg-card p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="grid size-8 place-items-center overflow-hidden rounded-full border border-border bg-muted">
                      {r.fromUser?.avatar ? <img src={r.fromUser.avatar} alt="" className="size-full object-cover" /> : <span className="text-[10px]">{r.fromUser?.name?.[0]}</span>}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{r.fromUser?.name}</p>
                      <p className="text-[10px] text-muted-foreground">{fmtRelative(r.createdAt, isFa ? "fa" : "en")}</p>
                    </div>
                  </div>
                  <StarRating value={r.rating} size={13} />
                </div>
                {r.comment && <p className="mt-2 text-sm text-muted-foreground">"{r.comment}"</p>}
                {r.tags && (() => { try { const tags = JSON.parse(r.tags); return Array.isArray(tags) && tags.length ? <div className="mt-2 flex flex-wrap gap-1">{tags.map((tag: string) => <span key={tag} className="rounded-full bg-amber/10 px-2 py-0.5 text-[10px] text-amber">{t(`completion.tag.${tag}`, tag)}</span>)}</div> : null; } catch { return null; } })()}
              </motion.div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
