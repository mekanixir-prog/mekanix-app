"use client";
import { useEffect, useState } from "react";
import {
  Home, Car, Wrench, MapPin, Receipt, History, MessageSquare, Bell, Settings, Plus, Crown, Headset,
  Truck, CalendarClock, Gift, Shield, Heart,
} from "lucide-react";
import { AppShell, type NavItem } from "@/components/mek/app-shell";
import { useApp } from "@/lib/store";
import { useActiveUser, type DemoUser } from "@/lib/use-active-user";
import { CustomerHome } from "./home";
import { CustomerVehicles } from "./vehicles";
import { RequestType, DescribeProblem, Matching, TechnicianProfileView } from "./request-flow";
import { CustomerTracking } from "./tracking";
import { CustomerInvoice } from "./invoice";
import { InvoiceDocument } from "./invoice-document";
import { CustomerCompletion } from "./completion";
import { CustomerHistory } from "./service-history";
import { CustomerChat } from "./chat";
import { CustomerSettings } from "./settings";
import { CustomerVip } from "./vip";
import { CustomerSupport } from "./support";
import { CustomerFleetDashboard } from "./fleet-dashboard";
import { CustomerMaintenance } from "./maintenance";
import { CustomerReferral } from "./referral";
import { CareDashboard } from "./care-dashboard";
import { CareBooking } from "./care-booking";
import { CareDetail } from "./care-detail";
import { CustomerInsurance } from "./insurance";
import { NotificationCenter } from "@/components/mek/shared/notification-center";
import { useT } from "@/lib/use-t";

export function CustomerApp() {
  const { view } = useApp();
  const { user, loading } = useActiveUser();
  const { t } = useT();
  const [incomingRequest, setIncomingRequest] = useState(0);

  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="size-8 animate-spin rounded-full border-2 border-amber border-t-transparent" />
      </div>
    );
  }

  // Guest fallback — construct a demo customer profile so the app is fully
  // browsable without a real login. Without this, a guest lands on an empty
  // state and can't see any customer UI ('پروفایل مشتری وجود نداره').
  // The demo profile has no real DB records, so mutations are client-side only.
  const activeUser: DemoUser = user ?? {
    id: "guest",
    name: "کاربر مهمان",
    phone: null,
    role: "CUSTOMER",
    email: null,
    phoneVerified: false,
    password: null,
    avatar: null,
    country: "",
    currency: "IRR",
    language: "fa",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "guest", userId: "guest" } as any,
    technician: null,
  };

  const nav: NavItem[] = [
    { view: "home", label: t("nav.home"), icon: Home },
    { view: "vehicles", label: t("nav.vehicles"), icon: Car },
    { view: "care", label: "MEKANIX CARE", icon: Heart },
    { view: "fleet-dashboard", label: t("fleet.title"), icon: Truck },
    { view: "maintenance", label: t("nav.maintenance"), icon: CalendarClock },
    { view: "service-history", label: t("nav.serviceHistory"), icon: History },
    { view: "vip", label: t("nav.vip"), icon: Crown },
    { view: "insurance", label: t("nav.insurance"), icon: Shield },
    { view: "referral", label: t("nav.referral"), icon: Gift },
    { view: "support", label: t("nav.support"), icon: Headset },
    { view: "notifications", label: t("nav.alerts"), icon: Bell },
    { view: "settings", label: t("nav.settings"), icon: Settings },
  ];

  const render = () => {
    switch (view) {
      case "home": return <CustomerHome customer={activeUser} />;
      case "vehicles": return <CustomerVehicles customer={activeUser} />;
      case "care": return <CareDashboard customer={activeUser} />;
      case "care-packages": return <CareBooking customer={activeUser} />;
      case "care-detail": return <CareDetail />;
      case "fleet-dashboard": return <CustomerFleetDashboard customer={activeUser} />;
      case "maintenance": return <CustomerMaintenance customer={activeUser} />;
      case "request-type": return <RequestType customer={activeUser} />;
      case "describe": return <DescribeProblem customer={activeUser} />;
      case "matching": return <Matching customer={activeUser} />;
      case "technician-profile": return <TechnicianProfileView customer={activeUser} />;
      case "track": return <CustomerTracking customer={activeUser} />;
      case "invoice": return <CustomerInvoice customer={activeUser} />;
      case "invoice-document": return <InvoiceDocument customer={activeUser} />;
      case "completion": return <CustomerCompletion customer={activeUser} />;
      case "service-history": return <CustomerHistory customer={activeUser} />;
      case "chat": return <CustomerChat customer={activeUser} />;
      case "vip": return <CustomerVip userId={activeUser.id} />;
      case "support": return <CustomerSupport userId={activeUser.id} />;
      case "referral": return <CustomerReferral userId={activeUser.id} />;
      case "insurance": return <CustomerInsurance customer={activeUser} />;
      case "notifications": return (
        <div className="rounded-xl border border-border bg-card" style={{ height: "calc(100vh - 8rem)" }}>
          <NotificationCenter userId={activeUser.id} />
        </div>
      );
      case "settings": return <CustomerSettings customer={activeUser} />;
      default: return <CustomerHome customer={activeUser} />;
    }
  };

  return (
    <AppShell nav={nav}>
      {render()}
    </AppShell>
  );
}
