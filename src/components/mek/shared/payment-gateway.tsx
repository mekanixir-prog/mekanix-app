"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck, CreditCard, Loader2, CheckCircle2, Lock, ChevronRight, ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";

type Stage = "form" | "otp" | "processing" | "done" | "failed";

// Iranian payment gateway simulator (Shaparak-style).
// Used for VIP subscription + pre-service payment + wallet top-up.
// In production: replace the fetch calls with Zarinpal/IDPay API.
export function PaymentGatewayDialog({
  open,
  onOpenChange,
  amount,
  purpose,
  description,
  userId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  amount: number; // USD
  purpose: "vip" | "prepay" | "invoice" | "wallet_topup";
  description?: string;
  userId?: string;
  onSuccess?: (paymentId: string, amount: number) => void;
}) {
  const { t, isFa, money } = useT();
  const [stage, setStage] = useState<Stage>("form");
  const [bank, setBank] = useState("mellat");
  const [card, setCard] = useState("");
  const [cardHolder, setCardHolder] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvv, setCvv] = useState("");
  const [mobile, setMobile] = useState("");
  const [otp, setOtp] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  const reset = () => {
    setStage("form");
    setCard(""); setCardHolder(""); setExpiry(""); setCvv(""); setMobile(""); setOtp("");
    setCode(null); setRef(null); setPaymentId(null);
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(reset, 250);
  };

  const formatCard = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 16);
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  };

  const formatExpiry = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 4);
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  };

  const initiate = async () => {
    if (card.replace(/\D/g, "").length < 16) {
      toast.error(t("pay.gateway.cardNumber"));
      return;
    }
    if (cvv.length < 3) {
      toast.error(t("pay.gateway.cvv"));
      return;
    }
    setStage("processing");
    try {
      const res = await authFetch("/api/gateway/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: userId ?? null,
          amount,
          purpose,
          description,
          mobile,
          cardNumber: card,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCode(data.code);
      setRef(data.referenceId);
      setStage("otp");
      toast.success(t("pay.gateway.otpSent").replace("{mobile}", mobile || "•••"));
    } catch (e: any) {
      toast.error(e.message ?? t("pay.gateway.failed"));
      setStage("failed");
    }
  };

  const verify = async () => {
    if (otp.length < 4) {
      toast.error(t("pay.gateway.otp"));
      return;
    }
    setStage("processing");
    try {
      const res = await authFetch("/api/gateway/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, otp, purpose, userId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPaymentId(data.paymentId);
      setStage("done");
      toast.success(t("pay.gateway.success"));
      if (onSuccess) onSuccess(data.paymentId, data.amount);
    } catch (e: any) {
      toast.error(e.message ?? t("pay.gateway.failed"));
      setStage("failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); else onOpenChange(v); }}>
      <DialogContent className="max-w-md" dir={isFa ? "rtl" : "ltr"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <div className="grid size-9 place-items-center rounded-lg border border-amber/30 bg-amber/10">
              <ShieldCheck className="size-4 text-amber" />
            </div>
            {t("pay.gateway.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">{t("pay.gateway.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-amber/20 bg-amber/5 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {description ?? t(`pay.gateway.title`)}
            </span>
            <span className="font-display text-lg font-bold text-amber">{money(amount)}</span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {stage === "form" && (
            <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
              <div>
                <Label className="text-xs">{t("pay.gateway.bank")}</Label>
                <Select value={bank} onValueChange={setBank}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mellat">{t("pay.gateway.bank.mellat")}</SelectItem>
                    <SelectItem value="melli">{t("pay.gateway.bank.melli")}</SelectItem>
                    <SelectItem value="saderat">{t("pay.gateway.bank.saderat")}</SelectItem>
                    <SelectItem value="tejarat">{t("pay.gateway.bank.tejarat")}</SelectItem>
                    <SelectItem value="sepah">{t("pay.gateway.bank.sepah")}</SelectItem>
                    <SelectItem value="other">{t("pay.gateway.bank.other")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{t("pay.gateway.cardNumber")}</Label>
                <div className="mt-1 relative">
                  <Input
                    value={card}
                    onChange={(e) => setCard(formatCard(e.target.value))}
                    placeholder="1234 5678 9012 3456"
                    inputMode="numeric"
                    className="pl-9 font-mono"
                    maxLength={19}
                  />
                  <CreditCard className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              <div>
                <Label className="text-xs">{t("pay.gateway.cardHolder")}</Label>
                <Input value={cardHolder} onChange={(e) => setCardHolder(e.target.value)} placeholder="ALI REZAEI" className="mt-1 uppercase" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">{t("pay.gateway.expiry")}</Label>
                  <Input value={expiry} onChange={(e) => setExpiry(formatExpiry(e.target.value))} placeholder="12/26" inputMode="numeric" className="mt-1 font-mono" maxLength={5} />
                </div>
                <div>
                  <Label className="text-xs">{t("pay.gateway.cvv")}</Label>
                  <Input value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="123" inputMode="numeric" type="password" className="mt-1 font-mono" maxLength={4} />
                </div>
              </div>
              <div>
                <Label className="text-xs">{t("pay.gateway.mobile")}</Label>
                <Input value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 11))} placeholder="09123456789" inputMode="numeric" className="mt-1 font-mono" />
              </div>
              <p className="text-[10px] text-muted-foreground">{t("pay.gateway.demoNote")}</p>
              <Button onClick={initiate} className="w-full bg-amber text-black hover:bg-amber/90" size="lg">
                <Lock className="mr-2 size-4" /> {t("pay.gateway.pay").replace("{amount}", money(amount))}
              </Button>
            </motion.div>
          )}

          {stage === "otp" && (
            <motion.div key="otp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
              <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-center">
                <p className="text-xs text-muted-foreground">{t("pay.gateway.otpSent").replace("{mobile}", mobile || "•••")}</p>
                {ref && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{ref}</p>}
              </div>
              <div>
                <Label className="text-xs">{t("pay.gateway.otp")}</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  className="mt-1 text-center font-mono text-lg tracking-widest"
                  autoFocus
                  maxLength={6}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">{t("pay.gateway.demoNote")}</p>
              </div>
              <Button onClick={verify} className="w-full bg-amber text-black hover:bg-amber/90" size="lg">
                {t("pay.gateway.verify")}
              </Button>
              <button onClick={() => setStage("form")} className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground">
                {isFa ? "بازگشت به فرم" : "Back to form"}
              </button>
            </motion.div>
          )}

          {stage === "processing" && (
            <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid place-items-center py-10">
              <Loader2 className="size-8 animate-spin text-amber" />
              <p className="mt-3 text-sm text-muted-foreground">{t("pay.gateway.processing")}</p>
            </motion.div>
          )}

          {stage === "done" && (
            <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-6 text-center">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
                className="mx-auto grid size-14 place-items-center rounded-full border-2 border-emerald-glow bg-emerald-glow/15"
              >
                <CheckCircle2 className="size-7 text-emerald-glow" />
              </motion.div>
              <h3 className="mt-4 font-display text-lg font-semibold">{t("pay.gateway.success")}</h3>
              {paymentId && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{paymentId}</p>}
              <Button onClick={close} className="mt-5 w-full bg-amber text-black hover:bg-amber/90">
                {t("common.close")}
              </Button>
            </motion.div>
          )}

          {stage === "failed" && (
            <motion.div key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-6 text-center">
              <h3 className="font-display text-lg font-semibold text-destructive">{t("pay.gateway.failed")}</h3>
              <div className="mt-4 flex gap-2">
                <Button onClick={reset} variant="outline" className="flex-1">{t("common.back")}</Button>
                <Button onClick={close} className="flex-1">{t("common.close")}</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
