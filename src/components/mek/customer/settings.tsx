"use client";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { COUNTRIES, CURRENCIES } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { User as UserIcon, Globe, Bell, Shield } from "lucide-react";
import { useTheme } from "@/components/mek/theme-provider";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";

export function CustomerSettings({ customer }: { customer: DemoUser }) {
  const { go } = useApp();
  const { t, isFa, lang } = useT();
  const { theme, setTheme } = useTheme();

  const notifItems = [
    { label: t("settings.notif.jobStatus"), desc: t("settings.notif.jobStatusDesc"), def: true },
    { label: t("settings.notif.estimate"), desc: t("settings.notif.estimateDesc"), def: true },
    { label: t("settings.notif.messages"), desc: t("settings.notif.messagesDesc"), def: true },
    { label: t("settings.notif.maintenance"), desc: t("settings.notif.maintenanceDesc"), def: true },
    { label: t("settings.notif.promotions"), desc: t("settings.notif.promotionsDesc"), def: false },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <div>
        <h1 className="font-display text-xl font-semibold">{t("settings.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><UserIcon className="size-4 text-amber" /> {t("settings.profile")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="grid size-14 place-items-center overflow-hidden rounded-full border border-border bg-muted">
              {customer.avatar ? <img src={customer.avatar} alt="" className="size-full object-cover" /> : <span className="font-semibold">{customer.name[0]}</span>}
            </div>
            <div className="flex-1">
              <p className="font-medium">{customer.name}</p>
              <p className="text-xs text-muted-foreground">{customer.email}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{t("settings.profile.fullName")}</Label>
              <Input defaultValue={customer.name} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">{t("settings.profile.phone")}</Label>
              <Input defaultValue={customer.phone ?? ""} className="mt-1" />
            </div>
          </div>
          {customer.customer?.company && (
            <div>
              <Label className="text-xs">{t("settings.profile.company")}</Label>
              <Input defaultValue={customer.customer.company} className="mt-1" />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Globe className="size-4 text-amber" /> {t("settings.regional")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{t("settings.regional.country")}</Label>
              <Select defaultValue={customer.country}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("settings.regional.currency")}</Label>
              <Select defaultValue={customer.currency}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CURRENCIES).map(([k, v]) => <SelectItem key={k} value={k}>{v.symbol} {v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">{t("settings.regional.language")}</Label>
            <Select value={lang} onValueChange={(v) => useApp.setState({ lang: v as any })}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="fa">فارسی</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("settings.regional.theme")}</Label>
            <Select value={theme} onValueChange={(v) => { setTheme(v); toast.success(t("toast.themeSwitched").replace("{theme}", v)); }}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">{t("common.dark")}</SelectItem>
                <SelectItem value="light">{t("common.light")}</SelectItem>
                <SelectItem value="system">{t("common.system")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Bell className="size-4 text-amber" /> {t("settings.notifications")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {notifItems.map((n, i) => (
            <div key={i} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{n.label}</p>
                <p className="text-[11px] text-muted-foreground">{n.desc}</p>
              </div>
              <Switch defaultChecked={n.def} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Shield className="size-4 text-amber" /> {t("settings.security")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" className="w-full justify-start" onClick={() => toast.info(t("settings.security.passwordSent"))}>{t("settings.security.password")}</Button>
          <Button variant="outline" className="w-full justify-start" onClick={() => toast.info(t("settings.security.2faSoon"))}>{t("settings.security.2fa")}</Button>
          <Button variant="outline" className="w-full justify-start text-destructive hover:bg-destructive/10" onClick={() => toast.info(t("settings.security.sessionCleared"))}>{t("settings.security.signOutAll")}</Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button className="bg-amber text-black hover:bg-amber/90" onClick={() => toast.success(t("settings.saved"))}>{t("common.saveChanges")}</Button>
      </div>
    </div>
  );
}
