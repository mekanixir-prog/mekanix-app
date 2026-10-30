"use client";
import {
  LayoutDashboard, Users, Wrench, Briefcase, CreditCard, WalletCards, Star, AlertTriangle,
  Layers, ShieldCheck, Settings, UserPlus,
} from "lucide-react";
import { AppShell, type NavItem } from "@/components/mek/app-shell";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { AdminOverview } from "./overview";
import { AdminCustomers } from "./customers";
import { AdminTechnicians } from "./technicians";
import { AdminJobs } from "./jobs";
import { AdminPayments } from "./payments";
import { AdminWithdrawals } from "./withdrawals";
import { AdminReviews } from "./reviews";
import { AdminDisputes } from "./disputes";
import { AdminCategories } from "./categories";
import { AdminVerification } from "./verification";
import { AdminApplications } from "./applications";
import { AdminSettings } from "./settings";
import { toPersianDigits } from "@/lib/format";

export function AdminApp() {
  const { view } = useApp();
  const { t } = useT();
  const NAV: NavItem[] = [
    { view: "overview", label: t("nav.overview"), icon: LayoutDashboard },
    { view: "applications", label: t("nav.applications"), icon: UserPlus },
    { view: "customers", label: t("nav.customers"), icon: Users },
    { view: "technicians", label: t("nav.technicians"), icon: Wrench },
    { view: "jobs", label: t("nav.jobs"), icon: Briefcase },
    { view: "payments", label: t("nav.payments"), icon: CreditCard },
    { view: "withdrawals", label: t("nav.withdrawals"), icon: WalletCards },
    { view: "reviews", label: t("nav.reviews"), icon: Star },
    { view: "disputes", label: t("nav.disputes"), icon: AlertTriangle },
    { view: "categories", label: t("nav.categories"), icon: Layers },
    { view: "verification", label: t("nav.verification"), icon: ShieldCheck },
    { view: "settings", label: t("nav.settings"), icon: Settings },
  ];
  const render = () => {
    switch (view) {
      case "overview": return <AdminOverview />;
      case "applications": return <AdminApplications />;
      case "customers": return <AdminCustomers />;
      case "technicians": return <AdminTechnicians />;
      case "jobs": return <AdminJobs />;
      case "payments": return <AdminPayments />;
      case "withdrawals": return <AdminWithdrawals />;
      case "reviews": return <AdminReviews />;
      case "disputes": return <AdminDisputes />;
      case "categories": return <AdminCategories />;
      case "verification": return <AdminVerification />;
      case "settings": return <AdminSettings />;
      default: return <AdminOverview />;
    }
  };
  return <AppShell nav={NAV} footer={<AdminFooter />}>{render()}</AppShell>;
}

function AdminFooter() {
  const { t, isFa } = useT();
  const year = isFa ? toPersianDigits(new Date().getFullYear()) : String(new Date().getFullYear());
  return (
    <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-muted-foreground" dir={isFa ? "rtl" : "ltr"}>
      <span className="font-mono">{t("admin.settings.footer.ops").replace("{year}", year)}</span>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-glow mk-status-pulse" /> {t("admin.settings.footer.allOperational")}</span>
        <span>{t("admin.settings.footer.region")}</span>
      </div>
    </div>
  );
}
