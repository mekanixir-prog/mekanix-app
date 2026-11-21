"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Gift, Copy, Share2, Loader2, Users, UserPlus, CheckCircle2, DollarSign,
  Wallet, Award, ChevronRight, Sparkles, UserCheck,
} from "lucide-react";
import { useT } from "@/lib/use-t";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { toast } from "sonner";
import { fmtDate, toPersianDigits } from "@/lib/format";

type ReferredUser = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
};

type Referral = {
  id: string;
  code: string;
  referrerId: string;
  referredEmail: string | null;
  referredUserId: string | null;
  referredUser: ReferredUser | null;
  status: string; // pending | signed_up | first_job | rewarded | expired
  rewardAmount: number;
  rewardClaimed: boolean;
  createdAt: string;
  completedAt: string | null;
};

type Stats = {
  total: number;
  signedUp: number;
  firstJob: number;
  earned: number;
  available: number;
};

const REWARD_AMOUNT = 5;

const STATUS_TONE: Record<string, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  signed_up: "border-sky-500/30 bg-sky-500/10 text-sky-400",
  first_job: "border-amber/30 bg-amber/10 text-amber",
  rewarded: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
  expired: "border-destructive/30 bg-destructive/10 text-destructive",
};

const STEP_ICONS = [Share2, UserPlus, CheckCircle2, Gift];

export function CustomerReferral({ userId }: { userId: string }) {
  const { t, isFa, money, lang } = useT();
  const [code, setCode] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<Referral[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // On mount: get-or-create the code + load referrals/stats
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const codeRes = await authFetch("/api/referral", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        });
        const codeData = await codeRes.json();
        if (!cancelled && codeData.code) setCode(codeData.code);
      } catch {
        if (!cancelled) setCode(null);
      }
      try {
        const r = await fetch(`/api/referral?userId=${userId}`);
        const data = await r.json();
        if (!cancelled) {
          setReferrals(Array.isArray(data.referrals) ? data.referrals : []);
          setStats(data.stats ?? null);
        }
      } catch {
        if (!cancelled) {
          setReferrals([]);
          setStats({ total: 0, signedUp: 0, firstJob: 0, earned: 0, available: 0 });
        }
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const shareLink = useMemo(() => (code ? `https://mekanix.ir/r/${code}` : ""), [code]);

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      toast.success(t("ref.copied"));
      setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      toast.error(isFa ? "کپی ناموفق بود" : "Copy failed");
    }
  };

  const copyLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopiedLink(true);
      toast.success(t("ref.copied"));
      setTimeout(() => setCopiedLink(false), 1500);
    } catch {
      toast.error(isFa ? "کپی ناموفق بود" : "Copy failed");
    }
  };

  const shareNative = async () => {
    if (!shareLink) return;
    const text = isFa
      ? `به مکانیکس بپیوندید! با کد ${code} ثبت‌نام کنید. ${shareLink}`
      : `Join me on MEKANIX! Use my code ${code} to sign up. ${shareLink}`;
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try {
        await (navigator as any).share({ title: "MEKANIX", text, url: shareLink });
        return;
      } catch {
        // fallthrough to clipboard
      }
    }
    await copyLink();
  };

  const claim = async (referralId: string) => {
    setClaimingId(referralId);
    try {
      const res = await authFetch("/api/referral", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referralId, action: "claim" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(t("ref.rewardClaimed"));
      // Refresh list
      const r = await fetch(`/api/referral?userId=${userId}`);
      const d = await r.json();
      setReferrals(Array.isArray(d.referrals) ? d.referrals : []);
      setStats(d.stats ?? null);
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    } finally {
      setClaimingId(null);
    }
  };

  const loading = referrals === null || stats === null;

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center" dir={isFa ? "rtl" : "ltr"}>
        <Loader2 className="size-6 animate-spin text-amber" />
      </div>
    );
  }

  const num = (n: number) => (isFa ? toPersianDigits(n) : String(n));
  const steps = [t("ref.step1"), t("ref.step2"), t("ref.step3"), t("ref.step4").replace("${amount}", money(REWARD_AMOUNT))];

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("ref.title")} subtitle={t("ref.subtitle")} />

      {/* Hero card with referral code */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card className="relative overflow-hidden border-amber/30 bg-gradient-to-br from-amber/5 via-card to-card">
          <div className="absolute -right-16 -top-16 size-56 rounded-full bg-amber/15 blur-3xl mk-radial-fade" />
          <CardContent className="relative p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber/10 px-2.5 py-0.5 text-[10px] font-medium text-amber">
                  <Sparkles className="size-3" /> {t("ref.yourCode")}
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-bold tracking-wider text-amber mk-text-glow">
                    {code ? (isFa ? toPersianDigits(code) : code) : (isFa ? "در حال ساخت…" : "Generating…")}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button onClick={copyCode} size="sm" variant="outline" className="gap-1">
                    {copiedCode ? <CheckCircle2 className="mr-1 size-3.5 text-emerald-glow" /> : <Copy className="mr-1 size-3.5" />}
                    {t("ref.copyCode")}
                  </Button>
                  <Button onClick={shareNative} size="sm" className="bg-amber text-black hover:bg-amber/90 gap-1">
                    <Share2 className="mr-1 size-3.5" /> {isFa ? "اشتراک‌گذاری" : "Share"}
                  </Button>
                </div>
              </div>
              <div className="grid size-14 shrink-0 place-items-center rounded-xl border border-amber/30 bg-amber/10">
                <Gift className="size-7 text-amber" />
              </div>
            </div>

            {/* Share link */}
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-background/60 p-2">
              <span className="shrink-0 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t("ref.shareLink")}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{shareLink}</code>
              <Button onClick={copyLink} size="sm" variant="ghost" className="h-7 px-2">
                {copiedLink ? <CheckCircle2 className="size-3.5 text-emerald-glow" /> : <Copy className="size-3.5" />}
              </Button>
            </div>

            {/* Invite desc */}
            <p className="mt-3 text-[11px] text-muted-foreground">
              {t("ref.inviteDesc").replace("${amount}", money(REWARD_AMOUNT))}
            </p>
          </CardContent>
        </Card>
      </motion.div>

      {/* How it works 4-step strip */}
      <div>
        <h3 className="mb-2 font-display text-sm font-semibold">{t("ref.howItWorks")}</h3>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {steps.map((step, i) => {
            const Icon = STEP_ICONS[i] ?? ChevronRight;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                className="relative rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <div className="grid size-7 place-items-center rounded-md border border-amber/30 bg-amber/10 text-amber">
                    <Icon className="size-3.5" />
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {isFa ? `گام ${toPersianDigits(i + 1)}` : `Step ${i + 1}`}
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-snug text-foreground">{step}</p>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={t("ref.stats.total")} value={num(stats?.total ?? 0)} icon={Users} tone="blue" />
        <StatCard label={t("ref.stats.signedUp")} value={num(stats?.signedUp ?? 0)} icon={UserCheck} tone="violet" />
        <StatCard label={t("ref.stats.firstJob")} value={num(stats?.firstJob ?? 0)} icon={CheckCircle2} tone="emerald" />
        <StatCard label={t("ref.stats.earned")} value={money(stats?.earned ?? 0)} icon={Award} tone="amber" />
        <StatCard
          label={t("ref.stats.available")}
          value={money(stats?.available ?? 0)}
          icon={Wallet}
          tone={(stats?.available ?? 0) > 0 ? "rose" : "neutral"}
        />
      </div>

      {/* Referrals list */}
      <div>
        <SectionHeader title={t("ref.referrals")} />
        <div className="mt-3">
          {(referrals ?? []).length === 0 ? (
            <EmptyState
              icon={Gift}
              title={t("ref.noReferrals")}
              description={t("ref.inviteDesc").replace("${amount}", money(REWARD_AMOUNT))}
            />
          ) : (
            <div className="space-y-2">
              <AnimatePresence>
                {(referrals ?? []).map((r, i) => {
                  const name = r.referredUser?.name ?? r.referredEmail ?? r.referredUser?.email ?? (isFa ? "کاربر دعوت‌شده" : "Invited user");
                  const canClaim = r.status === "first_job" && !r.rewardClaimed;
                  return (
                    <motion.div
                      key={r.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ delay: Math.min(i * 0.03, 0.3) }}
                    >
                      <Card className="transition-colors hover:border-amber/40">
                        <CardContent className="flex flex-wrap items-center gap-3 p-3">
                          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
                            <UserPlus className="size-4 text-amber" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold">{name}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {fmtDate(r.createdAt, undefined, lang)}
                              {r.completedAt && ` · ${isFa ? "تکمیل:" : "Completed:"} ${fmtDate(r.completedAt, undefined, lang)}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-amber">{money(r.rewardAmount)}</span>
                            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[r.status] ?? STATUS_TONE.pending}`}>
                              <span className="size-1.5 rounded-full bg-current mk-status-pulse" />
                              {t(`ref.status.${r.status}`, r.status)}
                            </span>
                            {canClaim && (
                              <Button
                                size="sm"
                                onClick={() => claim(r.id)}
                                disabled={claimingId === r.id}
                                className="bg-amber text-black hover:bg-amber/90"
                              >
                                {claimingId === r.id ? (
                                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                                ) : (
                                  <DollarSign className="mr-1 size-3.5" />
                                )}
                                {t("ref.claimReward").replace("${amount}", money(r.rewardAmount))}
                              </Button>
                            )}
                            {r.rewardClaimed && (
                              <Badge variant="outline" className="border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow">
                                <CheckCircle2 className="size-3" /> {isFa ? "دریافت شد" : "Claimed"}
                              </Badge>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
