"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CalendarClock, Plus, Loader2, CheckCircle2, Wrench, Save,
  Droplets, Disc3, BatteryCharging, CircleDot, Filter, ClipboardCheck, Settings2, ChevronLeft,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useT } from "@/lib/use-t";
import { api, type Vehicle } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { toast } from "sonner";
import { fmtDate, fmtRelative, toPersianDigits } from "@/lib/format";

type Schedule = {
  id: string;
  vehicleId: string;
  category: string;
  title: string;
  intervalKm: number | null;
  intervalHours: number | null;
  intervalDays: number | null;
  lastDoneDate: string | null;
  nextDueDate: string | null;
  notes: string | null;
  active: boolean;
  vehicle?: Vehicle;
};

const CATEGORIES = [
  { slug: "oil", icon: Droplets, tone: "amber" },
  { slug: "tires", icon: Disc3, tone: "blue" },
  { slug: "battery", icon: BatteryCharging, tone: "emerald" },
  { slug: "brake", icon: CircleDot, tone: "rose" },
  { slug: "filter", icon: Filter, tone: "violet" },
  { slug: "inspection", icon: ClipboardCheck, tone: "blue" },
  { slug: "custom", icon: Settings2, tone: "neutral" },
];

const CATEGORY_TONE: Record<string, string> = {
  amber: "border-amber/30 bg-amber/10 text-amber",
  blue: "border-sky-500/30 bg-sky-500/10 text-sky-400",
  emerald: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
  rose: "border-destructive/30 bg-destructive/10 text-destructive",
  violet: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  neutral: "border-border bg-muted text-muted-foreground",
};

function catIcon(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug)?.icon ?? Settings2;
}

function catTone(slug: string) {
  return CATEGORY_TONE[CATEGORIES.find((c) => c.slug === slug)?.tone ?? "neutral"] ?? CATEGORY_TONE.neutral;
}

function statusInfo(schedule: Schedule, isFa: boolean): { tone: string; label: string; days: number | null } {
  if (!schedule.nextDueDate) {
    return { tone: CATEGORY_TONE.neutral, label: isFa ? "بد تاریخ" : "No date", days: null };
  }
  const diff = new Date(schedule.nextDueDate).getTime() - Date.now();
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
  if (days < 0) {
    return { tone: "border-destructive/30 bg-destructive/10 text-destructive", label: `${toPersianDigits(Math.abs(days))} ${isFa ? "روز گذشته" : "days overdue"}`, days };
  }
  if (days === 0) {
    return { tone: "border-amber/30 bg-amber/10 text-amber", label: isFa ? "همین امروز" : "Due now", days };
  }
  if (days <= 7) {
    return { tone: "border-amber/30 bg-amber/10 text-amber", label: `${isFa ? `${toPersianDigits(days)} روز مانده` : `${days} days left`}`, days };
  }
  return { tone: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow", label: `${isFa ? `${toPersianDigits(days)} روز مانده` : `${days} days left`}`, days };
}

export function CustomerMaintenance({ customer }: { customer: DemoUser }) {
  const { t, isFa, lang } = useT();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);

  const load = async () => {
    if (!customer.customer) {
      setSchedules([]);
      return;
    }
    const cid = customer.customer.id;
    try {
      const [v, s] = await Promise.all([
        api.listVehicles(cid),
        fetch(`/api/maintenance?customerId=${cid}`).then((r) => r.json()),
      ]);
      setVehicles(v);
      setSchedules(Array.isArray(s) ? (s as Schedule[]) : []);
    } catch {
      setSchedules([]);
    }
  };

  useEffect(() => {
    load();
  }, [customer]);

  const vehicleById = useMemo(() => {
    const map: Record<string, Vehicle> = {};
    for (const v of vehicles) map[v.id] = v;
    return map;
  }, [vehicles]);

  const grouped = useMemo(() => {
    const groups: Record<string, Schedule[]> = {};
    for (const s of schedules ?? []) {
      if (!groups[s.vehicleId]) groups[s.vehicleId] = [];
      groups[s.vehicleId].push(s);
    }
    // Sort each group by nextDueDate asc (nulls last)
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => {
        const av = a.nextDueDate ? new Date(a.nextDueDate).getTime() : Infinity;
        const bv = b.nextDueDate ? new Date(b.nextDueDate).getTime() : Infinity;
        return av - bv;
      });
    }
    return groups;
  }, [schedules]);

  const markDone = async (id: string) => {
    setMarkingId(id);
    try {
      const res = await authFetch("/api/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "markDone" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(t("maint.markedDone"));
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    } finally {
      setMarkingId(null);
    }
  };

  if (schedules === null) {
    return (
      <div className="grid min-h-[40vh] place-items-center" dir={isFa ? "rtl" : "ltr"}>
        <Loader2 className="size-6 animate-spin text-amber" />
      </div>
    );
  }

  const num = (n: number | null | undefined) => (n == null ? "—" : isFa ? toPersianDigits(n) : String(n));

  const totalSchedules = schedules.length;
  const overdueCount = schedules.filter((s) => s.nextDueDate && new Date(s.nextDueDate).getTime() < Date.now()).length;

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader
        title={t("maint.title")}
        subtitle={t("maint.subtitle")}
        action={
          <Button onClick={() => setAddOpen(true)} className="bg-amber text-black hover:bg-amber/90">
            <Plus className="mr-1.5 size-4" /> {t("maint.addSchedule")}
          </Button>
        }
      />

      {/* Summary banner */}
      {totalSchedules > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("maint.subtitle")}</p>
            <p className="mt-1 font-display text-xl font-semibold">{num(totalSchedules)}</p>
          </div>
          <div className="rounded-lg border border-amber/30 bg-amber/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{isFa ? "به‌زودی سررسید" : "Due soon"}</p>
            <p className="mt-1 font-display text-xl font-semibold text-amber">
              {num(schedules.filter((s) => {
                if (!s.nextDueDate) return false;
                const d = new Date(s.nextDueDate).getTime() - Date.now();
                return d >= 0 && d <= 7 * 86400000;
              }).length)}
            </p>
          </div>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{isFa ? "گذشته" : "Overdue"}</p>
            <p className="mt-1 font-display text-xl font-semibold text-destructive">{num(overdueCount)}</p>
          </div>
        </div>
      )}

      {/* List grouped by vehicle */}
      {totalSchedules === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={t("maint.noSchedules")}
          description={t("maint.noSchedulesDesc")}
          action={
            <Button onClick={() => setAddOpen(true)} className="bg-amber text-black hover:bg-amber/90">
              <Plus className="mr-1.5 size-4" /> {t("maint.addSchedule")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([vehicleId, items]) => {
            const v = vehicleById[vehicleId];
            return (
              <div key={vehicleId}>
                <div className="mb-2 flex items-center gap-2">
                  <CalendarClock className="size-4 text-amber" />
                  <h3 className="font-display text-sm font-semibold">
                    {v ? `${v.make} ${v.model}` : isFa ? "خودرو حذف شده" : "Unknown vehicle"}
                  </h3>
                  {v && (
                    <span className="text-[11px] text-muted-foreground">
                      {isFa ? toPersianDigits(v.year) : v.year}
                    </span>
                  )}
                  <Badge variant="outline" className="ml-auto border-border text-[10px]">
                    {num(items.length)} {isFa ? "برنامه" : "schedules"}
                  </Badge>
                </div>
                <div className="space-y-2">
                  <AnimatePresence>
                    {items.map((s, i) => {
                      const CatIcon = catIcon(s.category);
                      const catToneClass = catTone(s.category);
                      const si = statusInfo(s, isFa);
                      const intervalStr = s.intervalKm
                        ? t("maint.intervalKm").replace("{km}", isFa ? toPersianDigits(s.intervalKm) : String(s.intervalKm))
                        : s.intervalDays
                        ? t("maint.intervalDays").replace("{days}", isFa ? toPersianDigits(s.intervalDays) : String(s.intervalDays))
                        : s.intervalHours
                        ? t("maint.intervalHours").replace("{hours}", isFa ? toPersianDigits(s.intervalHours) : String(s.intervalHours))
                        : "—";
                      return (
                        <motion.div
                          key={s.id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ delay: Math.min(i * 0.03, 0.3) }}
                        >
                          <Card className="overflow-hidden py-0 transition-colors hover:border-amber/40">
                            <CardContent className="grid gap-3 p-3 md:grid-cols-[auto_2fr_1fr_1fr_1.4fr_auto] md:items-center">
                              {/* Category badge */}
                              <div className={`inline-flex items-center gap-1.5 self-start rounded-md border px-2 py-0.5 text-[11px] font-medium ${catToneClass}`}>
                                <CatIcon className="size-3" />
                                {t(`maint.cat.${s.category}`, s.category)}
                              </div>

                              {/* Title + interval */}
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold">{s.title}</p>
                                <p className="text-[11px] text-muted-foreground">{intervalStr}</p>
                                {s.notes && <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground/80">{s.notes}</p>}
                              </div>

                              {/* Last done */}
                              <div>
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("maint.lastDone")}</p>
                                <p className="text-[11px]">
                                  {s.lastDoneDate ? fmtDate(s.lastDoneDate, undefined, lang) : "—"}
                                  {s.lastDoneDate && (
                                    <span className="block text-[10px] text-muted-foreground/80">{fmtRelative(s.lastDoneDate, lang)}</span>
                                  )}
                                </p>
                              </div>

                              {/* Next due */}
                              <div>
                                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("maint.nextDue")}</p>
                                <p className="text-[11px]">
                                  {s.nextDueDate ? fmtDate(s.nextDueDate, undefined, lang) : "—"}
                                </p>
                              </div>

                              {/* Status */}
                              <div>
                                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${si.tone}`}>
                                  <span className="size-1.5 rounded-full bg-current mk-status-pulse" />
                                  {si.label}
                                </span>
                              </div>

                              {/* Action */}
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={markingId === s.id}
                                onClick={() => markDone(s.id)}
                                className="gap-1 text-xs"
                              >
                                {markingId === s.id ? (
                                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="mr-1 size-3.5 text-emerald-glow" />
                                )}
                                {t("maint.markDone")}
                              </Button>
                            </CardContent>
                          </Card>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddScheduleDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        vehicles={vehicles}
        onCreated={load}
      />
    </div>
  );
}

function AddScheduleDialog({
  open,
  onOpenChange,
  vehicles,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  vehicles: Vehicle[];
  onCreated: () => void;
}) {
  const { t, isFa } = useT();
  const [vehicleId, setVehicleId] = useState("");
  const [category, setCategory] = useState("oil");
  const [title, setTitle] = useState("");
  const [intervalType, setIntervalType] = useState<"km" | "days" | "hours">("km");
  const [intervalKm, setIntervalKm] = useState("5000");
  const [intervalDays, setIntervalDays] = useState("90");
  const [intervalHours, setIntervalHours] = useState("250");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setVehicleId("");
    setCategory("oil");
    setTitle("");
    setIntervalType("km");
    setIntervalKm("5000");
    setIntervalDays("90");
    setIntervalHours("250");
    setNotes("");
  };

  const submit = async () => {
    if (!vehicleId) {
      toast.error(isFa ? "لطفاً خودرو را انتخاب کنید" : "Please select a vehicle");
      return;
    }
    if (!title.trim()) {
      toast.error(isFa ? "عنوان الزامی است" : "Title is required");
      return;
    }
    setSaving(true);
    try {
      const body: any = {
        vehicleId,
        category,
        title: title.trim(),
        notes: notes.trim() || null,
      };
      if (intervalType === "km") body.intervalKm = parseInt(intervalKm) || null;
      if (intervalType === "days") body.intervalDays = parseInt(intervalDays) || null;
      if (intervalType === "hours") body.intervalHours = parseInt(intervalHours) || null;

      const res = await authFetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(t("maint.scheduleAdded"));
      onCreated();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create schedule");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <CalendarClock className="size-5 text-amber" /> {t("maint.addSchedule")}
          </DialogTitle>
          <DialogDescription>{t("maint.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Vehicle */}
          <div>
            <Label className="text-xs">{t("fleet.vehicle")}</Label>
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={isFa ? "انتخاب خودرو" : "Select vehicle"} />
              </SelectTrigger>
              <SelectContent>
                {vehicles.length === 0 ? (
                  <SelectItem value="_none" disabled>
                    {isFa ? "خودرویی موجود نیست" : "No vehicles"}
                  </SelectItem>
                ) : (
                  vehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.make} {v.model} ({isFa ? toPersianDigits(v.year) : v.year})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Category */}
          <div>
            <Label className="text-xs">{t("maint.category")}</Label>
            <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-7">
              {CATEGORIES.map((c) => {
                const Icon = c.icon;
                const toneClass = catTone(c.slug);
                return (
                  <button
                    key={c.slug}
                    type="button"
                    onClick={() => setCategory(c.slug)}
                    className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors ${
                      category === c.slug
                        ? toneClass
                        : "border-border hover:bg-accent text-muted-foreground"
                    }`}
                  >
                    <Icon className="size-4" />
                    <span className="text-[9px] font-medium leading-tight">
                      {t(`maint.cat.${c.slug}`, c.slug)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title */}
          <div>
            <Label className="text-xs">{isFa ? "عنوان" : "Title"}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1"
              placeholder={isFa ? "مثلاً: تعویض روغن موتور" : "e.g. Engine oil change"}
            />
          </div>

          {/* Interval */}
          <div>
            <Label className="text-xs">{t("maint.interval")}</Label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(["km", "days", "hours"] as const).map((it) => (
                <button
                  key={it}
                  type="button"
                  onClick={() => setIntervalType(it)}
                  className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                    intervalType === it
                      ? "border-amber bg-amber/10 text-amber"
                      : "border-border text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {it === "km"
                    ? isFa ? "کیلومتر" : "Km"
                    : it === "days"
                    ? isFa ? "روز" : "Days"
                    : isFa ? "ساعت" : "Hours"}
                </button>
              ))}
            </div>
            <Input
              value={intervalType === "km" ? intervalKm : intervalType === "days" ? intervalDays : intervalHours}
              onChange={(e) => {
                if (intervalType === "km") setIntervalKm(e.target.value);
                else if (intervalType === "days") setIntervalDays(e.target.value);
                else setIntervalHours(e.target.value);
              }}
              type="number"
              className="mt-2"
            />
          </div>

          {/* Notes */}
          <div>
            <Label className="text-xs">{isFa ? "یادداشت" : "Notes"}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder={isFa ? "توضیحات اختیاری…" : "Optional notes…"}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {isFa ? "انصراف" : "Cancel"}
          </Button>
          <Button onClick={submit} disabled={saving} className="bg-amber text-black hover:bg-amber/90">
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Save className="mr-1.5 size-4" />}
            {saving ? (isFa ? "در حال ذخیره" : "Saving") : (isFa ? "ذخیره" : "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
