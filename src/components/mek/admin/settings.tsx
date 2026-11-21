"use client";
import { SectionHeader } from "@/components/mek/shared/primitives";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Globe, Sliders, Shield, Webhook, Building2, Percent } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/use-t";

export function AdminSettings() {
  const { t, isFa } = useT();

  const toggles = [
    { label: t("admin.settings.toggle.acceptCustomers"), desc: t("admin.settings.toggle.acceptCustomersDesc"), def: true },
    { label: t("admin.settings.toggle.acceptTechs"), desc: t("admin.settings.toggle.acceptTechsDesc"), def: true },
    { label: t("admin.settings.toggle.autoMatch"), desc: t("admin.settings.toggle.autoMatchDesc"), def: true },
    { label: t("admin.settings.toggle.emergency"), desc: t("admin.settings.toggle.emergencyDesc"), def: true },
    { label: t("admin.settings.toggle.maintenance"), desc: t("admin.settings.toggle.maintenanceDesc"), def: false },
  ];

  const integrations = [
    { name: t("admin.settings.integ.stripe"), status: t("admin.settings.integ.connected"), tone: "emerald" },
    { name: t("admin.settings.integ.twilio"), status: t("admin.settings.integ.connected"), tone: "emerald" },
    { name: t("admin.settings.integ.maps"), status: t("admin.settings.integ.configure"), tone: "amber" },
    { name: t("admin.settings.integ.fcm"), status: t("admin.settings.integ.configure"), tone: "amber" },
    { name: t("admin.settings.integ.ai"), status: t("admin.settings.integ.configure"), tone: "amber" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.settings.title")} subtitle={t("admin.settings.subtitle")} />

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Globe className="size-4 text-amber" /> {t("admin.settings.regions")}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">{t("admin.settings.defaultCountry")}</Label>
            <Select defaultValue="US">
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="US">United States</SelectItem>
                <SelectItem value="DE">Germany</SelectItem>
                <SelectItem value="AE">UAE</SelectItem>
                <SelectItem value="SA">Saudi Arabia</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.defaultCurrency")}</Label>
            <Select defaultValue="IRR">
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD — $</SelectItem>
                <SelectItem value="EUR">EUR — €</SelectItem>
                <SelectItem value="AED">AED — د.إ</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.defaultLanguage")}</Label>
            <Select defaultValue="en">
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="fa">فارسی</SelectItem>
                <SelectItem value="ar">العربية</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.timeZone")}</Label>
            <Select defaultValue="pst">
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pst">America/Los_Angeles</SelectItem>
                <SelectItem value="cet">Europe/Berlin</SelectItem>
                <SelectItem value="gst">Asia/Dubai</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Percent className="size-4 text-amber" /> {t("admin.settings.feesTax")}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">{t("admin.settings.commissionRate")}</Label>
            <Input defaultValue="12" type="number" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.defaultTaxRate")}</Label>
            <Input defaultValue="9" type="number" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.cancellationFee")}</Label>
            <Input defaultValue="15" type="number" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.warrantyMonthsLabel")}</Label>
            <Input defaultValue="6" type="number" className="mt-1" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Sliders className="size-4 text-amber" /> {t("admin.settings.platformToggles")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {toggles.map((s, i) => (
            <div key={i} className="flex items-center justify-between">
              <div><p className="text-sm font-medium">{s.label}</p><p className="text-[11px] text-muted-foreground">{s.desc}</p></div>
              <Switch defaultChecked={s.def} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Webhook className="size-4 text-amber" /> {t("admin.settings.integrations")}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {integrations.map((i) => (
            <div key={i.name} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="grid size-8 place-items-center rounded-lg border border-border bg-muted"><Webhook className="size-4 text-muted-foreground" /></div>
                <span className="text-sm font-medium">{i.name}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => toast.info(t("admin.settings.integ.openConfig").replace("{name}", i.name))}>{i.status}</Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><Building2 className="size-4 text-amber" /> {t("admin.settings.branding")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">{t("admin.settings.platformName")}</Label>
            <Input defaultValue="MEKANIX" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.supportEmail")}</Label>
            <Input defaultValue="ops@mekanix.io" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">{t("admin.settings.supportPhone")}</Label>
            <Input defaultValue="+1-415-000-0000" className="mt-1" />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button className="bg-amber text-black hover:bg-amber/90" onClick={() => toast.success(t("admin.settings.saved"))}>{t("admin.settings.save")}</Button>
      </div>
    </div>
  );
}
