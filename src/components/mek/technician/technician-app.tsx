"use client";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Inbox, Wrench, Wallet, CalendarClock, User as UserIcon, Star, Bell, ChevronRight,
} from "lucide-react";
import { AppShell, type NavItem } from "@/components/mek/app-shell";
import { useApp } from "@/lib/store";
import { useActiveUser } from "@/lib/use-active-user";
import { TechnicianDashboard } from "./dashboard";
import { TechnicianRequests } from "./requests";
import { TechnicianJobDetail } from "./job-detail";
import { TechnicianEarnings } from "./earnings";
import { TechnicianSchedule } from "./schedule";
import { TechnicianProfile } from "./profile";
import { TechnicianReviews } from "./reviews";
import { TechnicianChat } from "./chat";
import { NotificationCenter } from "@/components/mek/shared/notification-center";
import { EmptyState } from "@/components/mek/shared/primitives";
import { api, type Job } from "@/lib/api";
import { useT } from "@/lib/use-t";

export function TechnicianApp() {
  const { view } = useApp();
  const { t } = useT();
  const { user, loading } = useActiveUser();
  const [incomingCount, setIncomingCount] = useState(0);

  useEffect(() => {
    if (!user?.technician) return;
    api.listJobs({ technicianId: user.technician.id }).then((jobs: Job[]) => {
      setIncomingCount(jobs.filter((j) => j.status === "REQUESTED" || j.status === "ACCEPTED").length);
    }).catch(() => {});
  }, [user]);

  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="size-8 animate-spin rounded-full border-2 border-amber border-t-transparent" />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground mb-2" dir="rtl">{t("common.loading")}</p>
        </div>
      </div>
    );
  }
  if (!user?.technician) {
    return <EmptyState icon={Wrench} title={t("common.noTechnicianTitle")} description={t("common.noTechnicianDesc")} className="m-6" />;
  }

  const nav: NavItem[] = [
    { view: "dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
    { view: "requests", label: t("nav.requests"), icon: Inbox, badge: incomingCount },
    { view: "earnings", label: t("nav.earnings"), icon: Wallet },
    { view: "schedule", label: t("nav.schedule"), icon: CalendarClock },
    { view: "reviews", label: t("nav.reviews"), icon: Star },
    { view: "notifications", label: t("nav.alerts"), icon: Bell },
    { view: "profile", label: t("nav.profile"), icon: UserIcon },
  ];

  const render = () => {
    switch (view) {
      case "dashboard": return <TechnicianDashboard user={user} />;
      case "requests": return <TechnicianRequests user={user} />;
      case "job-detail": return <TechnicianJobDetail user={user} />;
      case "earnings": return <TechnicianEarnings user={user} />;
      case "schedule": return <TechnicianSchedule user={user} />;
      case "profile": return <TechnicianProfile user={user} />;
      case "reviews": return <TechnicianReviews user={user} />;
      case "chat": return <TechnicianChat user={user} />;
      case "notifications": return (
        <div className="rounded-xl border border-border bg-card" style={{ height: "calc(100vh - 8rem)" }}>
          <NotificationCenter userId={user.id} />
        </div>
      );
      default: return <TechnicianDashboard user={user} />;
    }
  };

  return <AppShell nav={nav}>{render()}</AppShell>;
}
