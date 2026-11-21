"use client";
import { cn } from "@/lib/utils";
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, CheckCheck, BellOff } from "lucide-react";
import { api, type Notification } from "@/lib/api";
import { NOTIFICATION_TYPES } from "@/lib/constants";
import { fmtRelative, toPersianDigits } from "@/lib/format";
import { MekIcon } from "./icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./primitives";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";

const CATEGORY_FILTERS = [
  { key: "all", labelKey: "notif.filter.all" },
  { key: "job", labelKey: "notif.filter.job" },
  { key: "payment", labelKey: "notif.filter.payment" },
  { key: "message", labelKey: "notif.filter.message" },
  { key: "maintenance", labelKey: "notif.filter.maintenance" },
  { key: "system", labelKey: "notif.filter.system" },
] as const;

export function NotificationCenter({ userId }: { userId: string }) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const { go } = useApp();
  const { t, isFa } = useT();

  const load = useCallback(async () => {
    const data = await api.listNotifications(userId).catch(() => []);
    setItems(data);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const data = await api.listNotifications(userId).catch(() => []);
      if (!cancelled) setItems(data);
    };
    run();
    // poll for new notifications to simulate real-time
    const poll = setInterval(run, 12000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [userId]);

  const markRead = async (id: string) => {
    await api.markNotificationRead(id).catch(() => {});
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, read: true } : n)) ?? null);
  };

  const markAll = async () => {
    await api.markAllRead(userId).catch(() => {});
    setItems((prev) => prev?.map((n) => ({ ...n, read: true })) ?? null);
    toast.success(t("notif.markedAll"));
  };

  const filtered = items?.filter((n) => filter === "all" || n.category === filter);
  const unread = items?.filter((n) => !n.read).length ?? 0;

  return (
    <div className="flex h-full flex-col" dir={isFa ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bell className="size-4 text-amber" />
          <h2 className="font-display text-sm font-semibold">{t("notif.title")}</h2>
          {unread > 0 && (
            <span className="rounded-full bg-amber/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber">
              {t("notif.unreadCount").replace("{n}", isFa ? toPersianDigits(unread) : String(unread))}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={markAll} disabled={!unread}>
          <CheckCheck className="size-3.5" /> {t("notif.markAllRead")}
        </Button>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {CATEGORY_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              filter === f.key ? "border-amber bg-amber/15 text-amber" : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          {items === null ? (
            <div className="space-y-2 p-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filtered && filtered.length === 0 ? (
            <EmptyState icon={BellOff} title={t("notif.empty")} description={t("notif.emptyDesc")} className="m-2" />
          ) : (
            <div className="space-y-1">
              <AnimatePresence initial={false}>
                {filtered?.map((n) => {
                  const meta = NOTIFICATION_TYPES[n.type] ?? { icon: "Bell", label: n.type };
                  return (
                    <motion.button
                      key={n.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      onClick={() => {
                        markRead(n.id);
                        if (n.link) {
                          const [role, view] = n.link.split("/");
                          if (role === "customer") go(view);
                          else if (role === "technician") go(view);
                          else if (role === "admin") go(view);
                        }
                      }}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                        n.read ? "border-transparent bg-card/40" : "border-amber/30 bg-amber/[0.06] hover:bg-amber/[0.1]"
                      )}
                    >
                      <div className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border", n.read ? "border-border text-muted-foreground" : "border-amber/40 bg-amber/10 text-amber")}>
                        <MekIcon name={meta.icon} className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className={cn("truncate text-[13px] font-medium", !n.read && "text-foreground")}>{t(`notif.type.${n.type}`, n.title)}</p>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtRelative(n.createdAt, isFa ? "fa" : "en")}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                          {(() => {
                            const bodyKey = `notif.body.${n.type}`;
                            const translated = t(bodyKey);
                            if (translated === bodyKey) return n.body;
                            const nameMatch = n.body.match(/^(.+?)\s+(?:is|has|on)/);
                            const name = nameMatch?.[1] ?? "";
                            const codeMatch = n.body.match(/(JOB-\d+)/);
                            const code = codeMatch?.[1] ?? "";
                            return translated
                              .replace("{name}", name)
                              .replace("{code}", code)
                              .replace("{eta}", "")
                              .replace("— ETA  دقیقه", "")
                              .replace("{vehicle}", "")
                              .replace("{title}", "");
                          })()}
                        </p>
                        <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{t(`notif.filter.${n.category}`)}</span>
                      </div>
                      {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-amber mk-status-pulse" />}
                    </motion.button>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
