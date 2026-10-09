"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell, Sun, Moon, Menu, X, RefreshCw, ShieldCheck, User as UserIcon, Wrench, LogOut, ArrowLeftRight, Car, Truck, Languages,
} from "lucide-react";
import { useTheme } from "@/components/mek/theme-provider";
import { Logo } from "./brand/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { NotificationCenter } from "./shared/notification-center";
import { useActiveUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { useT, LANGS, type Lang } from "@/lib/use-t";
import type { Role } from "@/lib/api";
import { toast } from "sonner";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";

// Map nav view → translation key
const NAV_LABELS: Record<string, string> = {
  home: "nav.home", vehicles: "nav.vehicles", "service-history": "nav.serviceHistory",
  notifications: "nav.alerts", settings: "nav.settings", dashboard: "nav.dashboard",
  requests: "nav.requests", earnings: "nav.earnings", schedule: "nav.schedule",
  reviews: "nav.reviews", profile: "nav.profile", overview: "nav.overview",
  applications: "nav.applications", customers: "nav.customers", technicians: "nav.technicians",
  jobs: "nav.jobs", payments: "nav.payments", disputes: "nav.disputes",
  categories: "nav.categories", verification: "nav.verification",
};

export interface NavItem {
  view: string;
  label: string;
  icon: any;
  badge?: number;
}

export function AppShell({
  nav,
  children,
  footer,
}: {
  nav: NavItem[];
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { view, go, reset, portal, auth, machineMode, setMachineMode, exitToSplash, bootStage, lang, setLang } = useApp();
  const { t, isFa } = useT();
  const { user } = useActiveUser();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const switchMode = () => {
    const next = machineMode === "heavy" ? "passenger" : "heavy";
    setMachineMode(next);
    toast.success(next === "heavy" ? t("mode.switchedHeavy") : t("mode.switchedPassenger"));
    reset("home");
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  // Listen for "open mobile nav" event (from MobileBottomNav "more" button)
  useEffect(() => {
    const handler = () => setMobileNavOpen(true);
    window.addEventListener("mekanix-open-mobile-nav", handler);
    return () => window.removeEventListener("mekanix-open-mobile-nav", handler);
  }, []);

  // poll unread notifications
  useEffect(() => {
    if (!user) return;
    let active = true;
    const tick = async () => {
      try {
        const list = await fetch(`/api/notifications?userId=${user.id}`).then((r) => r.json());
        if (active) setUnread(list.filter((n: any) => !n.read).length);
      } catch {}
    };
    tick();
    const notifInterval = setInterval(tick, 15000);
    return () => {
      active = false;
      clearInterval(notifInterval);
    };
  }, [user]);

  const reseed = async () => {
    toast.loading(t("common.reseedLoading"), { id: "reseed" });
    try {
      await authFetch("/api/seed", { method: "POST" });
      toast.success(t("common.reseedSuccess"), { id: "reseed", description: t("common.reseedReloading") });
      setTimeout(() => window.location.reload(), 800);
    } catch {
      toast.error(t("common.reseedFail"), { id: "reseed" });
    }
  };

  const SidebarContent = (
    <nav className="flex flex-col gap-1 p-3">
      {nav.map((item) => (
        <button
          key={item.view}
          onClick={() => {
            reset(item.view);
            setMobileNavOpen(false);
          }}
          className={cn(
            "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            view === item.view
              ? "bg-amber/15 text-amber"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <item.icon className="size-4" />
          <span className="flex-1 text-left">{NAV_LABELS[item.view] ? t(NAV_LABELS[item.view]) : item.label}</span>
          {item.badge ? (
            <span className="rounded-full bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber">
              {item.badge}
            </span>
          ) : null}
          {view === item.view && <motion.div layoutId="nav-active" className="absolute left-0 h-6 w-0.5 rounded-r bg-amber" />}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          <button className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent md:hidden" onClick={() => setMobileNavOpen(true)}>
            <Menu className="size-5" />
          </button>
          <button onClick={() => reset("home")} className="flex items-center">
            <Logo size={30} />
          </button>

          <div className="ml-auto flex items-center gap-1">
            {/* Language toggle */}
            <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card/60 p-0.5">
              {LANGS.map((l) => (
                <button
                  key={l.code}
                  onClick={() => setLang(l.code as Lang)}
                  className={`relative rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${lang === l.code ? "text-black" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {lang === l.code && <motion.div layoutId="header-lang-pill" className="absolute inset-0 rounded-md bg-amber" transition={{ type: "spring", stiffness: 350, damping: 30 }} />}
                  <span className="relative">{l.label}</span>
                </button>
              ))}
            </div>

            {portal === "customer" && bootStage === "app" && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" className="gap-1.5 px-2.5" onClick={switchMode}>
                      {machineMode === "heavy" ? <Truck className="size-3.5 text-emerald-glow" /> : <Car className="size-3.5 text-amber" />}
                      <span className="hidden text-[11px] font-medium sm:inline">{machineMode === "heavy" ? (isFa ? "سنگین" : "Heavy") : (isFa ? "سواری" : "Passenger")}</span>
                      <ArrowLeftRight className="size-3 text-muted-foreground" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.switchMachine")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-9" onClick={reseed}>
                    <RefreshCw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("common.reseed")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <Sheet open={notifOpen} onOpenChange={setNotifOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="relative size-9">
                  <Bell className="size-4" />
                  {unread > 0 && (
                    <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-amber px-1 text-[9px] font-bold text-black">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full p-0 sm:max-w-md" side="right">
                <SheetTitle className="sr-only">{t("common.notifications")}</SheetTitle>
                {user && <NotificationCenter userId={user.id} />}
              </SheetContent>
            </Sheet>

            {mounted && (
              <Button variant="ghost" size="icon" className="size-9" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            )}

            <RoleSwitcher />

            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-9" onClick={exitToSplash}>
                    <LogOut className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("common.signOut")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Desktop sidebar */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 border-r border-border bg-card/30 md:block">
          <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto">{SidebarContent}</div>
            <div className="border-t border-border p-3">
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-background/50 p-2">
                <div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted">
                  {user?.avatar ? (
                     
                    <img src={user.avatar} alt={user.name} className="size-full object-cover" />
                  ) : (
                    <UserIcon className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{user?.name ?? "—"}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{user?.email ?? "loading"}</p>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="mx-auto w-full max-w-7xl p-3 pb-20 sm:p-5 md:pb-5"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Footer */}
      {footer && <footer className="mt-auto border-t border-border bg-card/30">{footer}</footer>}

      {/* Mobile bottom navigation — sticky quick-access bar */}
      <MobileBottomNav nav={nav} />

      {/* Mobile nav (slide-out drawer) */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">{t("common.mobileNav")}</SheetTitle>
          <div className="flex h-14 items-center justify-between border-b border-border px-4">
            <Logo size={26} />
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setMobileNavOpen(false)}>
              <X className="size-4" />
            </Button>
          </div>
          {SidebarContent}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Mobile bottom navigation ───
// Sticky bar at the bottom of the screen (mobile only) with quick-access to
// the 4 most important nav items + a "more" button that opens the full drawer.
function MobileBottomNav({ nav }: { nav: NavItem[] }) {
  const { view, reset } = useApp();
  const { t } = useT();
  // Take up to 4 items for the bottom bar; if there are more, show a "more" button
  const max = 4;
  const visible = nav.slice(0, max);
  const hasMore = nav.length > max;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label={t("common.mobileNav")}
    >
      <div className="grid h-14 grid-cols-5 gap-1 px-2">
        {visible.map((item) => {
          const active = view === item.view;
          return (
            <button
              key={item.view}
              onClick={() => reset(item.view)}
              className={`relative flex flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-colors ${
                active ? "text-amber" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <div className={`relative grid size-7 place-items-center rounded-lg ${active ? "bg-amber/15" : ""}`}>
                <item.icon className="size-[18px]" />
                {item.badge ? (
                  <span className="absolute -right-1 -top-1 grid min-w-3.5 place-items-center rounded-full bg-amber px-1 text-[8px] font-bold text-black">
                    {item.badge > 9 ? "9+" : item.badge}
                  </span>
                ) : null}
              </div>
              <span className="truncate leading-tight">{NAV_LABELS[item.view] ? t(NAV_LABELS[item.view]) : item.label}</span>
              {active && (
                <motion.div layoutId="bottom-nav-active" className="absolute -top-px h-0.5 w-8 rounded-full bg-amber" />
              )}
            </button>
          );
        })}
        {hasMore && (
          <button
            onClick={() => {
              const event = new Event("mekanix-open-mobile-nav");
              window.dispatchEvent(event);
            }}
            className="flex flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            <div className="grid size-7 place-items-center">
              <Menu className="size-[18px]" />
            </div>
            <span>بیشتر</span>
          </button>
        )}
      </div>
    </nav>
  );
}

const ROLE_META: { key: Role; labelKey: string; icon: any }[] = [
  { key: "CUSTOMER", labelKey: "common.roleCustomer", icon: UserIcon },
  { key: "TECHNICIAN", labelKey: "common.roleTechnician", icon: Wrench },
  { key: "ADMIN", labelKey: "common.roleAdmin", icon: ShieldCheck },
];

function RoleSwitcher() {
  const { role, setRole } = useApp();
  const { t } = useT();
  return (
    <div className="flex items-center rounded-lg border border-border bg-card/60 p-0.5">
      {ROLE_META.map((r) => (
        <button
          key={r.key}
          onClick={() => setRole(r.key)}
          className={cn(
            "relative flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors sm:px-2.5",
            role === r.key ? "text-black" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {role === r.key && (
            <motion.div layoutId="role-pill" className="absolute inset-0 rounded-md bg-amber" transition={{ type: "spring", stiffness: 350, damping: 30 }} />
          )}
          <r.icon className="relative size-3.5" />
          <span className="relative hidden sm:inline">{t(r.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
