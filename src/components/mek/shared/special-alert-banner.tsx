"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { XCircle, X, RefreshCw, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { fmtRelative, toPersianDigits } from "@/lib/format";

type Alert = {
  id: string;
  type: string;
  title: string;
  body: string;
  category: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

// Special alert banner that appears for high-priority notifications
// (e.g. mechanic rejected the request). Distinct from the regular
// notification center — these are "modal-like" banners that need attention.
export function SpecialAlertBanner({ userId }: { userId: string }) {
  const { go } = useApp();
  const { t, isFa, lang } = useT();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) return;
    let active = true;
    const fetchAlerts = async () => {
      try {
        const res = await fetch(`/api/notifications?userId=${userId}`);
        const list = await res.json();
        if (!active) return;
        // Only show "alert" category + "request_rejected" type, unread.
        const filtered: Alert[] = (list as Alert[]).filter(
          (n) => !n.read && (n.category === "alert" || n.type === "request_rejected")
        );
        setAlerts(filtered);
      } catch {}
    };
    fetchAlerts();
    const poll = setInterval(fetchAlerts, 10000); // poll every 10s
    return () => { active = false; clearInterval(poll); };
  }, [userId]);

  const dismiss = (id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
    // Mark as read on backend so it doesn't reappear
    fetch(`/api/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).catch(() => {});
  };

  const visible = alerts.filter((a) => !dismissed.has(a.id));

  if (visible.length === 0) return null;

  return (
    <div className="space-y-2" dir={isFa ? "rtl" : "ltr"}>
      <AnimatePresence>
        {visible.slice(0, 3).map((alert) => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 280, damping: 25 }}
            className="relative overflow-hidden rounded-xl border-2 border-rose-500/50 bg-rose-500/10 p-4 shadow-lg"
          >
            {/* Pulse glow */}
            <div className="absolute inset-0 -z-10 bg-rose-500/5 animate-pulse" />
            <div className="flex items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-rose-500/40 bg-rose-500/20">
                <XCircle className="size-5 text-rose-500" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-display text-sm font-semibold text-rose-500">{alert.title}</h4>
                  <span className="text-[10px] text-muted-foreground">{fmtRelative(alert.createdAt, lang)}</span>
                </div>
                <p className="mt-0.5 text-xs text-foreground">{alert.body}</p>
                <div className="mt-2 flex gap-2">
                  {alert.type === "request_rejected" && (
                    <Button
                      size="sm"
                      onClick={() => go("request-type")}
                      className="bg-rose-500 text-white hover:bg-rose-600 h-7 px-2.5 text-[11px]"
                    >
                      <RefreshCw className="mr-1 size-3" /> {isFa ? "یافتن مکانیک دیگر" : "Find another mechanic"}
                    </Button>
                  )}
                  {alert.link && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // Map link → view (e.g. "customer/track" → "track")
                        const view = alert.link?.split("/").pop() ?? "home";
                        go(view);
                      }}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      {isFa ? "مشاهده" : "View"} <ChevronRight className="ml-1 size-3" />
                    </Button>
                  )}
                </div>
              </div>
              <button
                onClick={() => dismiss(alert.id)}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-rose-500/20 hover:text-rose-500"
                aria-label={t("common.close")}
              >
                <X className="size-4" />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
