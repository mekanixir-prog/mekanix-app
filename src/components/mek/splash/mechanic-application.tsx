"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { Wrench, Loader2, CheckCircle2, ShieldCheck, BadgeCheck, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SERVICE_CATEGORIES } from "@/lib/constants";
import { MekIcon } from "@/components/mek/shared/icons";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/format";

export function MechanicApplicationForm({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t, isFa, cat } = useT();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [exp, setExp] = useState("3");
  const [specs, setSpecs] = useState<string[]>([]);
  const [bio, setBio] = useState("");
  const [hasVehicle, setHasVehicle] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [code, setCode] = useState("");

  const toggleSpec = (s: string) => setSpecs((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));

  const submit = async () => {
    if (!fullName.trim() || !phone.trim()) {
      toast.error(t("mech.required"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/mechanic-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName, phone, email, city, experienceYears: exp, specialties: specs, bio, vehicleOwned: hasVehicle,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCode(data.code);
      setDone(true);
      toast.success(t("mech.submitted"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setFullName(""); setPhone(""); setEmail(""); setCity(""); setExp("3"); setSpecs([]); setBio(""); setHasVehicle(false);
    setDone(false); setCode("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setTimeout(reset, 200); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <div className="grid size-9 place-items-center rounded-lg border border-amber/30 bg-amber/10">
              <Wrench className="size-4 text-amber" />
            </div>
            {t("mech.applyTitle")}
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="py-6 text-center" dir={isFa ? "rtl" : "ltr"}>
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
              className="mx-auto grid size-14 place-items-center rounded-full border-2 border-emerald-glow bg-emerald-glow/15"
            >
              <CheckCircle2 className="size-7 text-emerald-glow" />
            </motion.div>
            <h3 className="mt-4 font-display text-xl font-semibold">{t("mech.received")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("mech.refCode")} <span className="font-mono font-medium text-amber">{isFa ? toPersianDigits(code) : code}</span>
            </p>
            <div className="mt-3 rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 p-3 text-sm text-emerald-glow">
              {t("splash.applicationApproved")}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
              {[
                { icon: ShieldCheck, label: t("mech.verified") },
                { icon: BadgeCheck, label: t("mech.certified") },
                { icon: Wrench, label: t("mech.mobile") },
              ].map((s, i) => (
                <div key={i} className="rounded-lg border border-border bg-background p-2.5 text-center">
                  <s.icon className="mx-auto size-4 text-amber" />
                  <p className="mt-1 text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 flex gap-2">
              <Button onClick={reset} variant="outline" className="flex-1">{t("mech.done")}</Button>
              <Button onClick={() => {
                reset();
                onOpenChange(false);
                window.dispatchEvent(new CustomEvent("mekanix-go-mechanic-login", { detail: { phone } }));
              }} className="flex-1 bg-amber text-black hover:bg-amber/90">
                {t("splash.goToMechanicLogin")}
              </Button>
            </div>
          </motion.div>
        ) : (
          <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
            <div className="rounded-lg border border-amber/20 bg-amber/5 p-3 text-[11px] text-muted-foreground">
              {t("mech.intro")}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">{t("mech.fullName")}</Label>
                <Input value={fullName} onChange={(e) => setFullName(e.target.value)} className="mt-1" placeholder={t("mech.fullNamePlaceholder")} />
              </div>
              <div>
                <Label className="text-xs">{t("mech.mobileLabel")}</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1" placeholder={t("mech.mobilePlaceholder")} inputMode="tel" />
              </div>
              <div>
                <Label className="text-xs">{t("mech.emailLabel")}</Label>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1" placeholder={t("mech.emailPlaceholder")} />
              </div>
              <div>
                <Label className="text-xs">{t("mech.cityLabel")}</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} className="mt-1" placeholder={t("mech.cityPlaceholder")} />
              </div>
              <div>
                <Label className="text-xs">{t("mech.experience")}</Label>
                <Input value={exp} onChange={(e) => setExp(e.target.value)} type="number" min={0} className="mt-1" />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hasVehicle} onChange={(e) => setHasVehicle(e.target.checked)} className="size-4 accent-amber" />
                  {t("mech.hasVehicle")}
                </label>
              </div>
            </div>

            <div>
              <Label className="text-xs">{t("mech.specialties")}</Label>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {SERVICE_CATEGORIES.map((c) => (
                  <button
                    key={c.slug}
                    onClick={() => toggleSpec(c.slug)}
                    className={`flex items-center gap-2 rounded-lg border p-2.5 text-left transition-colors ${specs.includes(c.slug) ? "border-amber bg-amber/10" : "border-border hover:bg-accent"}`}
                  >
                    <MekIcon name={c.icon} className={`size-4 ${specs.includes(c.slug) ? "text-amber" : "text-muted-foreground"}`} />
                    <span className="text-[11px] font-medium leading-tight">{cat(c.slug)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs">{t("mech.about")}</Label>
              <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} className="mt-1" placeholder={t("mech.aboutPlaceholder")} />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("mech.cancel")}</Button>
              <Button onClick={submit} disabled={submitting} className="bg-amber text-black hover:bg-amber/90">
                {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
                {submitting ? t("mech.submitting") : t("mech.submit")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
