"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Crown, Check, Zap, ShieldCheck, Clock, Star, Headset, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { PaymentGatewayDialog } from "@/components/mek/shared/payment-gateway";
import { toPersianDigits } from "@/lib/format";

type VipPlan = {
  id: string;
  slug: string;
  name: string;
  priceIrr: number;
  durationDays: number;
  discountPct: number;
  priorityBoost: number;
  warrantyMonths: number;
  dedicatedSupport: boolean;
  freeInspectionsPerMonth: number;
  active: boolean;
  order: number;
};

type VipSubscription = {
  id: string;
  status: string;
  startedAt: string | null;
  expiresAt: string | null;
  plan: VipPlan;
};

const PLAN_TONES: Record<string, { border: string; bg: string; text: string; ring: string }> = {
  silver: { border: "border-slate-400/40", bg: "bg-slate-400/5", text: "text-slate-300", ring: "ring-slate-400/30" },
  gold: { border: "border-amber/40", bg: "bg-amber/5", text: "text-amber", ring: "ring-amber/40" },
  platinum: { border: "border-violet-400/40", bg: "bg-violet-400/5", text: "text-violet-300", ring: "ring-violet-400/30" },
};

export function CustomerVip({ userId }: { userId: string }) {
  const { t, isFa, money, lang } = useT();
  const [plans, setPlans] = useState<VipPlan[]>([]);
  const [subscription, setSubscription] = useState<VipSubscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<VipPlan | null>(null);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    Promise.all([
      authFetch("/api/vip/plans").then((r) => r.json()),
      fetch(`/api/vip/my?userId=${userId}`).then((r) => r.json().catch(() => null)),
    ]).then(([p, s]) => {
      setPlans(Array.isArray(p) ? p : []);
      setSubscription(s?.subscription ?? null);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [userId]);

  const subscribe = (plan: VipPlan) => {
    setSelectedPlan(plan);
    setGatewayOpen(true);
  };

  const onPaid = async (paymentId: string) => {
    if (!selectedPlan) return;
    setSubscribing(true);
    try {
      const res = await authFetch("/api/vip/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, planId: selectedPlan.id, paymentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSubscription(data.subscription);
      toast.success(t("vip.subscribeSuccess"));
      setGatewayOpen(false);
    } catch (e: any) {
      toast.error(e.message ?? t("vip.subscribeFail"));
    } finally {
      setSubscribing(false);
    }
  };

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center" dir={isFa ? "rtl" : "ltr"}>
        <Loader2 className="size-6 animate-spin text-amber" />
      </div>
    );
  }

  const active = subscription?.status === "ACTIVE";
  const daysLeft = active && subscription?.expiresAt
    ? Math.max(0, Math.ceil((new Date(subscription.expiresAt).getTime() - Date.now()) / 86400000))
    : 0;

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("vip.title")} subtitle={t("vip.subtitle")} />

      {/* Active plan banner */}
      {active && subscription && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-xl border p-4 ${PLAN_TONES[subscription.plan.slug]?.border ?? "border-amber/40"} ${PLAN_TONES[subscription.plan.slug]?.bg ?? "bg-amber/5"}`}
        >
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl border border-amber/30 bg-amber/10">
              <Crown className="size-5 text-amber" />
            </div>
            <div className="flex-1">
              <p className="font-display text-sm font-semibold">{t(`vip.plan.${subscription.plan.slug}`)}</p>
              <p className="text-[11px] text-muted-foreground">
                {t("vip.expiresIn").replace("{days}", isFa ? toPersianDigits(daysLeft) : String(daysLeft))}
              </p>
            </div>
            <span className="rounded-full border border-emerald-glow/40 bg-emerald-glow/10 px-2 py-0.5 text-[10px] font-medium text-emerald-glow">
              {t("vip.active")}
            </span>
          </div>
        </motion.div>
      )}

      {/* Plans grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((plan, i) => {
          const tone = PLAN_TONES[plan.slug] ?? PLAN_TONES.gold;
          const isCurrent = active && subscription?.plan?.id === plan.id;
          return (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
            >
              <Card className={`relative overflow-hidden ${tone.border} ${isCurrent ? `ring-2 ${tone.ring}` : ""}`}>
                {plan.slug === "gold" && (
                  <div className="absolute right-3 top-3 rounded-full bg-amber px-2 py-0.5 text-[9px] font-bold uppercase text-black">
                    {isFa ? "محبوب‌ترین" : "Most popular"}
                  </div>
                )}
                <CardContent className="p-5">
                  <div className="flex items-center gap-2">
                    <Crown className={`size-5 ${tone.text}`} />
                    <h3 className="font-display text-base font-semibold">{t(`vip.plan.${plan.slug}`)}</h3>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{t(`vip.plan.${plan.slug}Desc`)}</p>

                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="font-display text-2xl font-bold text-foreground">{money(plan.priceIrr)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      / {t("vip.plan.duration").replace("{days}", isFa ? toPersianDigits(plan.durationDays) : String(plan.durationDays))}
                    </span>
                  </div>

                  <ul className="mt-4 space-y-2 text-xs">
                    <Perk icon={Zap} label={t("vip.plan.discount").replace("{pct}", isFa ? toPersianDigits(plan.discountPct) : String(plan.discountPct))} />
                    <Perk icon={Clock} label={t("vip.plan.warranty").replace("{months}", isFa ? toPersianDigits(plan.warrantyMonths) : String(plan.warrantyMonths))} />
                    <Perk icon={Star} label={t("vip.plan.boost").replace("{n}", isFa ? toPersianDigits(plan.priorityBoost) : String(plan.priorityBoost))} />
                    {plan.freeInspectionsPerMonth > 0 && (
                      <Perk icon={ShieldCheck} label={t("vip.plan.freeInspections").replace("{n}", isFa ? toPersianDigits(plan.freeInspectionsPerMonth) : String(plan.freeInspectionsPerMonth))} />
                    )}
                    <Perk
                      icon={Headset}
                      label={plan.dedicatedSupport ? t("vip.plan.dedicatedSupport") : t("vip.plan.notDedicatedSupport")}
                      dim={!plan.dedicatedSupport}
                    />
                  </ul>

                  <Button
                    onClick={() => subscribe(plan)}
                    disabled={isCurrent || subscribing}
                    className={`mt-5 w-full ${isCurrent ? "bg-muted text-muted-foreground" : "bg-amber text-black hover:bg-amber/90"}`}
                  >
                    {isCurrent ? <Check className="mr-2 size-4" /> : <Crown className="mr-2 size-4" />}
                    {isCurrent ? t("vip.currentPlan") : t("vip.checkout")}
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {plans.length === 0 && (
        <EmptyState icon={Crown} title={t("vip.active.none")} description={t("vip.subtitle")} />
      )}

      {selectedPlan && (
        <PaymentGatewayDialog
          open={gatewayOpen}
          onOpenChange={setGatewayOpen}
          amount={selectedPlan.priceIrr}
          purpose="vip"
          userId={userId}
          description={t(`vip.plan.${selectedPlan.slug}`)}
          onSuccess={onPaid}
        />
      )}
    </div>
  );
}

function Perk({ icon: Icon, label, dim }: { icon: any; label: string; dim?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <Icon className={`size-3.5 ${dim ? "text-muted-foreground/50" : "text-amber"}`} />
      <span className={dim ? "text-muted-foreground line-through" : "text-foreground"}>{label}</span>
    </li>
  );
}
