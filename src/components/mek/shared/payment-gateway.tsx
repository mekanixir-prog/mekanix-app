"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck, Loader2, CheckCircle2, Lock, ChevronRight, ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";

type Stage = "form" | "otp" | "processing" | "done" | "failed";

// Iranian payment gateway simulator (Shaparak-style).
// VIP uses the server-priced gateway simulator. Prepay uses its separate
// local prepay endpoint; neither flow enables a real provider.
export function PaymentGatewayDialog({
  open,
  onOpenChange,
  amount,
  purpose,
  description,
  planId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  amount: number; // Display-only fallback; server resolves the payable IRR amount from planId.
  purpose: "vip" | "prepay";
  description?: string;
  planId?: string;
  onSuccess?: (paymentId: string, amount: number) => Promise<number | void> | number | void;
}) {
  const { t, isFa, money } = useT();
  const [stage, setStage] = useState<Stage>("form");
  const [otp, setOtp] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [serverAmount, setServerAmount] = useState<number | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");

  const reset = () => {
    setStage("form");
    setOtp("");
    setCode(null); setRef(null); setPaymentId(null); setServerAmount(null); setIdempotencyKey("");
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(reset, 250);
  };

  const initiate = async () => {
    if (purpose === "prepay") {
      setServerAmount(amount);
      setCode("SIMULATED-PREPAY");
      setRef("LOCAL-SIMULATOR");
      setStage("otp");
      return;
    }
    if (!planId) {
      toast.error(t("pay.gateway.failed"));
      setStage("failed");
      return;
    }
    setStage("processing");
    const requestKey = idempotencyKey || crypto.randomUUID();
    if (!idempotencyKey) setIdempotencyKey(requestKey);
    try {
      const res = await authFetch("/api/gateway/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose: "vip",
          planId,
          idempotencyKey: requestKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCode(data.code);
      setRef(data.referenceId);
      setServerAmount(Number(data.amount));
      setStage("otp");
      toast.success(isFa ? "کد آزمایشی شبیه‌ساز آماده است." : "Simulator test code is ready.");
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
      if (purpose === "prepay") {
        const confirmedAmount = await onSuccess?.("SIMULATED-PREPAY", serverAmount ?? amount);
        if (typeof confirmedAmount === "number" && Number.isFinite(confirmedAmount)) {
          setServerAmount(confirmedAmount);
        }
        setPaymentId("SIMULATED-PREPAY");
        setStage("done");
        toast.success(t("pay.gateway.success"));
        return;
      }

      const res = await authFetch("/api/gateway/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, otp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const confirmedAmount = Number(data.amount);
      const fulfilledAmount = await onSuccess?.(data.paymentId, confirmedAmount);
      if (typeof fulfilledAmount === "number" && Number.isFinite(fulfilledAmount)) {
        setServerAmount(fulfilledAmount);
      }
      setPaymentId(data.paymentId);
      setStage("done");
      toast.success(t("pay.gateway.success"));
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
            <span className="font-display text-lg font-bold text-amber">{money(serverAmount ?? amount)}</span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {stage === "form" && (
            <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
              {purpose === "vip" && (
                <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-sm">
                  {isFa
                    ? "این فقط شبیه‌ساز محلی است؛ اطلاعات کارت بانکی، CVV یا رمز واقعی وارد نکنید."
                    : "Local simulator only. Do not enter real card numbers, CVV, or banking credentials."}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">{t("pay.gateway.demoNote")}</p>
              <Button onClick={initiate} className="w-full bg-amber text-black hover:bg-amber/90" size="lg">
                <Lock className="mr-2 size-4" /> {t("pay.gateway.pay").replace("{amount}", money(serverAmount ?? amount))}
              </Button>
            </motion.div>
          )}

          {stage === "otp" && (
            <motion.div key="otp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
              <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-center">
                <p className="text-xs text-muted-foreground">
                  {isFa ? "کد ثابت محیط آزمایشی: ۱۲۳۴" : "Fixed simulator test code: 1234"}
                </p>
                {ref && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{ref}</p>}
              </div>
              <div>
                <Label className="text-xs">{t("pay.gateway.otp")}</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="1234"
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
                <Button onClick={() => setStage("form")} variant="outline" className="flex-1">{t("common.back")}</Button>
                <Button onClick={close} className="flex-1">{t("common.close")}</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
