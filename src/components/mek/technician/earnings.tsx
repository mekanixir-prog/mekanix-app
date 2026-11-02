"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Wallet, TrendingUp, Clock, Banknote, Calendar, Lock, AlertCircle,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { StatCard, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { RevenueAreaChart, MiniSparkline } from "@/components/mek/shared/charts";
import { fmtDate, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidIranianSheba } from "@/lib/iranian-iban";

type Wallet = {
  id: string;
  currency: "IRR" | "UNVERIFIED";
  earningsSummary: {
    currency: "IRR" | "UNVERIFIED";
    valid: boolean;
    todayIrr: number | null;
    last7DaysIrr: number | null;
    series14d: { date: string; revenue: number; jobs: number }[];
  };
  balance: number;
  pendingBalance: number;
  totalEarned: number;
  totalCommission: number;
  totalWithdrawn: number;
  transactions: WalletTxn[];
  withdrawals: WithdrawalReq[];
};

type WalletTxn = {
  id: string;
  jobId: string | null;
  kind: string;
  status: string;
  grossAmount: number;
  commissionAmount: number;
  netAmount: number;
  holdUntil: string | null;
  releasedAt: string | null;
  description: string | null;
  createdAt: string;
};

type WithdrawalReq = {
  id: string;
  code: string;
  amount: number;
  method: string;
  cardNumber: string | null;
  shebaNumber: string | null;
  bankName: string | null;
  status: string;
  requestedAt: string;
  processedAt: string | null;
};

const MIN_WITHDRAWAL_IRR = 1; // technical minimum: one integer Rial; no USD denomination

export function TechnicianEarnings({ user }: { user: DemoUser }) {
  const { t, isFa, money, lang } = useT();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawSheba, setWithdrawSheba] = useState("");
  const [withdrawBank, setWithdrawBank] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const withdrawalIdempotencyKey = useRef<string | null>(null);

  const loadWallet = async (techId: string) => {
    try {
      const res = await fetch(`/api/wallets?technicianId=${techId}`);
      if (!res.ok) throw new Error("Wallet request failed");
      const w = await res.json();
      if (!["IRR", "UNVERIFIED"].includes(w?.currency) || w?.earningsSummary?.currency !== w?.currency) {
        setWallet(null);
        return;
      }
      setWallet(w);
    } catch {}
  };

  useEffect(() => {
    if (!user.technician) return;
    loadWallet(user.technician.id);
    const poll = setInterval(() => loadWallet(user.technician!.id), 30000); // refresh every 30s for countdown
    return () => clearInterval(poll);
  }, [user]);

  // The chart uses positive net amounts from the wallet ledger, not customer invoice gross.
  const series = wallet?.currency === "IRR" && wallet.earningsSummary?.valid
    ? wallet.earningsSummary.series14d
    : [];
  const spark = series.map((item) => item.revenue);
  const moneyDisplay = (amount: number) => wallet?.currency === "IRR" ? money(amount, "IRR") : "—";

  const balance = wallet?.balance ?? 0;
  const pending = wallet?.pendingBalance ?? 0;
  const totalEarned = wallet?.totalEarned ?? 0;
  const totalCommission = wallet?.totalCommission ?? 0;
  const totalWithdrawn = wallet?.totalWithdrawn ?? 0;

  const submitWithdraw = async () => {
    if (wallet?.currency !== "IRR") {
      toast.error("واحد موجودی کیف پول هنوز تأیید نشده است؛ برداشت پس از تطبیق مالی فعال می‌شود");
      return;
    }
    const amt = Number(withdrawAmount);
    if (!Number.isSafeInteger(amt) || amt < MIN_WITHDRAWAL_IRR) {
      toast.error(t("tech.earnings.withdrawMin").replace("{amount}", moneyDisplay(MIN_WITHDRAWAL_IRR)));
      return;
    }
    if (amt > balance) {
      toast.error(t("tech.earnings.withdrawInsufficient"));
      return;
    }
    const normalizedSheba = withdrawSheba.replace(/\s+/g, "").toUpperCase();
    if (!withdrawBank.trim() || !isValidIranianSheba(normalizedSheba)) {
      toast.error("برای برداشت، نام بانک و شبای معتبر لازم است");
      return;
    }
    setWithdrawing(true);
    const idempotencyKey = withdrawalIdempotencyKey.current ?? crypto.randomUUID();
    withdrawalIdempotencyKey.current = idempotencyKey;
    try {
      const res = await authFetch("/api/wallets/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          amount: amt,
          currency: "IRR",
          method: "bank",
          shebaNumber: normalizedSheba,
          bankName: withdrawBank.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(t("tech.earnings.withdrawSubmitted"));
      setWithdrawOpen(false);
      withdrawalIdempotencyKey.current = null;
      setWithdrawAmount(""); setWithdrawSheba(""); setWithdrawBank("");
      await loadWallet(user.technician!.id);
    } catch (e: any) {
      toast.error(e.message ?? "Withdrawal failed");
    } finally {
      setWithdrawing(false);
    }
  };

  // Live countdown for held transactions
  const pendingTxns = (wallet?.transactions ?? []).filter((t) => t.status === "PENDING" && t.holdUntil);

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("tech.earnings.title")} subtitle={t("tech.earnings.subtitle")} />
      {wallet?.currency === "UNVERIFIED" && (
        <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs leading-6 text-muted-foreground">
          واحد پول موجودی‌های قدیمی هنوز با داده‌های منبع تطبیق داده نشده است. برای جلوگیری از نمایش یا برداشت مبلغ اشتباه، ارقام مالی و برداشت تا تکمیل تطبیق موقتاً غیرفعال‌اند.
        </div>
      )}

      {/* Wallet KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("tech.earnings.availableBalance")} value={moneyDisplay(balance)} icon={Wallet} tone="amber" sub={t("tech.earnings.readyWithdraw")} />
        <StatCard label={t("tech.earnings.pendingBalance")} value={moneyDisplay(pending)} icon={Clock} tone="blue" sub={t("tech.earnings.holdPeriod")} />
        <StatCard label={t("tech.earnings.totalGross")} value={moneyDisplay(totalEarned)} icon={TrendingUp} tone="emerald"  />
        <StatCard label={t("tech.earnings.commission")} value={moneyDisplay(totalCommission)} icon={AlertCircle} tone="violet" sub={t("tech.earnings.commissionDesc")} />
      </div>

      {/* Hold policy banner */}
      <div className="rounded-lg border border-amber/20 bg-amber/5 p-3 text-[11px] text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Lock className="size-3.5 text-amber" />
          <span className="font-medium text-amber">{t("tech.earnings.holdPeriod")}</span>
          <span>·</span>
          <span>{t("tech.earnings.holdDesc")}</span>
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold">{t("tech.earnings.revenue14")}</h3>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-2 rounded-full bg-amber" /> {t("tech.earnings.earned")}
            </div>
          </div>
          <RevenueAreaChart data={series} height={200} className="mt-3" />
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-display text-sm font-semibold">{t("tech.earnings.payoutSchedule")}</h3>
          <div className="mt-3 space-y-2">
            <div className="rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 p-3">
              <p className="text-[11px] uppercase tracking-wide text-emerald-glow">{t("tech.earnings.availableBalance")}</p>
              <p className="mt-0.5 font-display text-lg font-bold text-amber">{moneyDisplay(balance)}</p>
              <p className="text-[11px] text-muted-foreground">{t("tech.earnings.released")}</p>
            </div>
            <Button
              className="w-full bg-amber text-black hover:bg-amber/90"
              onClick={() => setWithdrawOpen(true)}
              disabled={wallet?.currency !== "IRR" || balance < MIN_WITHDRAWAL_IRR}
            >
              <Banknote className="mr-2 size-4" /> {t("tech.earnings.withdrawNow")}
            </Button>
            {balance < MIN_WITHDRAWAL_IRR && (
              <p className="text-center text-[10px] text-muted-foreground">
                {t("tech.earnings.withdrawMin").replace("{amount}", moneyDisplay(MIN_WITHDRAWAL_IRR))}
              </p>
            )}
          </div>
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("tech.earnings.trend14")}</p>
            <MiniSparkline data={spark.length ? spark : [0, 0, 0, 0]} className="mt-1" height={40} />
          </div>
        </div>
      </div>

      {/* Pending transactions (with live countdown) */}
      {pendingTxns.length > 0 && (
        <div>
          <SectionHeader title={t("tech.earnings.pendingBalance")} subtitle={t("tech.earnings.holdDesc")} />
          <div className="mt-3 space-y-2">
            {pendingTxns.slice(0, 5).map((txn) => {
              const msLeft = new Date(txn.holdUntil!).getTime() - Date.now();
              const hours = Math.max(0, Math.floor(msLeft / 3600000));
              const mins = Math.max(0, Math.floor((msLeft % 3600000) / 60000));
              const released = msLeft <= 0;
              const countdown = isFa
                ? `${toPersianDigits(hours)} ساعت ${toPersianDigits(mins)} دقیقه`
                : `${hours}h ${mins}m`;
              return (
                <div key={txn.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{txn.description ?? t("tech.earnings.txnType.PREPAY")}</p>
                    <p className="text-[11px] text-muted-foreground">{fmtDate(txn.createdAt, undefined, lang)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-display text-sm font-semibold text-amber">{moneyDisplay(txn.netAmount)}</p>
                    <p className={`text-[10px] ${released ? "text-emerald-glow" : "text-muted-foreground"}`}>
                      {released ? t("tech.earnings.released") : t("tech.earnings.countdown").replace("{time}", countdown)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent transactions */}
      <div>
        <SectionHeader title={t("tech.earnings.recentTransactions")} />
        <div className="mt-3">
          {(wallet?.transactions ?? []).length === 0 ? (
            <EmptyState icon={Wallet} title={t("tech.earnings.noPayments")} description={t("tech.earnings.noPaymentsDesc")} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">{t("tech.earnings.col.job")}</th>
                    <th className="px-4 py-2.5 text-left font-medium">{t("tech.earnings.col.date")}</th>
                    <th className="px-4 py-2.5 text-left font-medium">{t("common.status")}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{t("tech.earnings.col.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(wallet?.transactions ?? []).slice(0, 10).map((txn) => (
                    <tr key={txn.id} className="border-t border-border">
                      <td className="px-4 py-2.5 text-xs">
                        <span className="font-medium">{t(`tech.earnings.txnType.${txn.kind}` as any) ?? txn.kind}</span>
                        {txn.description && <p className="text-[10px] text-muted-foreground">{txn.description}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(txn.createdAt, undefined, lang)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                          txn.status === "COMPLETED" || txn.status === "AVAILABLE"
                            ? "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow"
                            : txn.status === "PENDING"
                            ? "border-amber/30 bg-amber/10 text-amber"
                            : "border-border bg-muted text-muted-foreground"
                        }`}>
                          {t(`tech.earnings.txnStatus.${txn.status}` as any) ?? txn.status}
                        </span>
                      </td>
                      <td className={`px-4 py-2.5 text-right font-medium ${txn.netAmount >= 0 ? "text-amber" : "text-destructive"}`}>
                        {moneyDisplay(Math.abs(txn.netAmount))} {txn.netAmount >= 0 ? "+" : "−"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Withdrawal history */}
      <div>
        <SectionHeader title={t("tech.earnings.withdrawHistory")} />
        <div className="mt-3">
          {(wallet?.withdrawals ?? []).length === 0 ? (
            <EmptyState icon={Banknote} title={t("tech.earnings.noWithdrawals")} description="" />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Code</th>
                    <th className="px-4 py-2.5 text-left font-medium">{t("tech.earnings.col.date")}</th>
                    <th className="px-4 py-2.5 text-left font-medium">{t("common.status")}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{t("tech.earnings.col.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(wallet?.withdrawals ?? []).slice(0, 10).map((w) => (
                    <tr key={w.id} className="border-t border-border">
                      <td className="px-4 py-2.5 font-mono text-xs">{w.code}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(w.requestedAt, undefined, lang)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                          w.status === "PAID" ? "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow"
                          : w.status === "APPROVED" ? "border-amber/30 bg-amber/10 text-amber"
                          : w.status === "REJECTED" ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-border bg-muted text-muted-foreground"
                        }`}>
                          {t(`tech.earnings.wdStatus.${w.status}` as any) ?? w.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-amber">{moneyDisplay(w.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Withdraw dialog */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="max-w-md" dir={isFa ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="size-5 text-amber" /> {t("tech.earnings.withdrawDialog")}
            </DialogTitle>
            <DialogDescription>
              {t("tech.earnings.availableBalance")}: <span className="font-medium text-amber">{moneyDisplay(balance)}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">{t("tech.earnings.withdrawAmount")}</Label>
              <Input
                type="number"
                min={MIN_WITHDRAWAL_IRR}
                max={balance}
                value={withdrawAmount}
                onChange={(e) => { withdrawalIdempotencyKey.current = null; setWithdrawAmount(e.target.value); }}
                className="mt-1"
                placeholder={`حداقل ${moneyDisplay(MIN_WITHDRAWAL_IRR)}`}
              />
            </div>
            <div>
              <Label className="text-xs">{t("tech.earnings.withdrawMethod")}</Label>
              <div className="mt-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                {t("pay.gateway.bank")}
              </div>
            </div>
            <div>
              <Label className="text-xs">{t("tech.earnings.withdrawSheba")}</Label>
              <Input
                value={withdrawSheba}
                onChange={(e) => { withdrawalIdempotencyKey.current = null; setWithdrawSheba(e.target.value.replace(/\s+/g, "").toUpperCase().slice(0, 26)); }}
                className="mt-1 font-mono"
                placeholder="IR000000000000000000000000"
              />
            </div>
            <div>
              <Label className="text-xs">{t("tech.earnings.withdrawBank")}</Label>
              <Input value={withdrawBank} onChange={(e) => { withdrawalIdempotencyKey.current = null; setWithdrawBank(e.target.value); }} className="mt-1" placeholder="بانک ملت" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setWithdrawOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={submitWithdraw} disabled={withdrawing} className="bg-amber text-black hover:bg-amber/90">
              {withdrawing ? "..." : t("tech.earnings.withdrawDialog")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
