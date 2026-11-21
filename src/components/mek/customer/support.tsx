"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Headset, Plus, Phone, MessageSquare, Mail, Clock, Search, Loader2,
  CheckCircle2, AlertCircle, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { fmtRelative, toPersianDigits } from "@/lib/format";

type Ticket = {
  id: string;
  code: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  message: string;
  reply: string | null;
  createdAt: string;
  resolvedAt: string | null;
  user?: { name: string };
};

const CATEGORIES = ["billing", "jobs", "account", "technical", "other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

const STATUS_TONE: Record<string, string> = {
  open: "border-amber/30 bg-amber/10 text-amber",
  pending: "border-sky-500/30 bg-sky-500/10 text-sky-400",
  resolved: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
  closed: "border-border bg-muted text-muted-foreground",
};

const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground",
  normal: "text-foreground",
  high: "text-amber",
  urgent: "text-destructive",
};

export function CustomerSupport({ userId }: { userId: string }) {
  const { t, isFa, lang } = useT();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("jobs");
  const [priority, setPriority] = useState("normal");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");

  const load = async () => {
    try {
      const res = await fetch(`/api/support/tickets?userId=${userId}`);
      const data = await res.json();
      setTickets(Array.isArray(data) ? data : []);
    } catch {
      setTickets([]);
    }
  };

  useEffect(() => { load(); }, [userId]);

  const submit = async () => {
    if (!subject.trim() || !message.trim()) {
      toast.error(t("support.ticketMessage"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await authFetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, subject, category, priority, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(t("support.ticketCreated").replace("{id}", data.code));
      setOpen(false);
      setSubject(""); setMessage(""); setCategory("jobs"); setPriority("normal");
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = (tickets ?? []).filter((tk) =>
    !search.trim() ||
    tk.subject.toLowerCase().includes(search.toLowerCase()) ||
    tk.code.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader
        title={t("support.title")}
        subtitle={t("support.subtitle")}
        action={<Button onClick={() => setOpen(true)} className="bg-amber text-black hover:bg-amber/90"><Plus className="mr-1.5 size-4" /> {t("support.newTicket")}</Button>}
      />

      {/* Contact cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        <ContactCard icon={Phone} title={t("support.contactPhone")} desc={isFa ? "۰۲۱-۹۱۰۰۲۰۳۰" : "+98 21 9100 2030"} tone="amber" onClick={() => toast.info(isFa ? "در حال اتصال..." : "Connecting...")} />
        <ContactCard icon={MessageSquare} title={t("support.contactChat")} desc={isFa ? "گفتگوی زنده ۲۴/۷" : "Live chat 24/7"} tone="emerald" onClick={() => toast.info(isFa ? "گفتگو شروع شد" : "Chat started")} />
        <ContactCard icon={Mail} title={t("support.contactEmail")} desc="support@mekanix.ir" tone="violet" onClick={() => toast.info(isFa ? "ایمیل باز شد" : "Email opened")} />
      </div>

      {/* Response time banner */}
      <div className="rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 p-3">
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock className="size-3.5 text-emerald-glow" />
          <span className="font-medium text-emerald-glow">{t("support.responseTime")}</span>
        </p>
      </div>

      {/* Search */}
      {tickets && tickets.length > 0 && (
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("support.searchFaq")}
            className="pl-9"
          />
        </div>
      )}

      {/* Ticket list */}
      <div>
        {tickets === null ? (
          <div className="grid place-items-center py-12"><Loader2 className="size-6 animate-spin text-amber" /></div>
        ) : tickets.length === 0 ? (
          <EmptyState icon={Headset} title={t("support.empty")} description={t("support.emptyDesc")} />
        ) : (
          <div className="space-y-2">
            <AnimatePresence>
              {filtered.map((tk, i) => (
                <motion.div
                  key={tk.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: i * 0.04 }}
                >
                  <Card className="hover:border-amber/40 transition-colors">
                    <CardContent className="p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-muted-foreground">{isFa ? toPersianDigits(tk.code) : tk.code}</span>
                            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${STATUS_TONE[tk.status] ?? STATUS_TONE.open}`}>
                              {t(`support.status.${tk.status}` as any) ?? tk.status}
                            </span>
                            <span className={`text-[10px] font-medium ${PRIORITY_TONE[tk.priority] ?? ""}`}>
                              {t(`support.priority.${tk.priority}` as any) ?? tk.priority}
                            </span>
                          </div>
                          <h3 className="mt-1 truncate text-sm font-semibold">{tk.subject}</h3>
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{tk.message}</p>
                          {tk.reply && (
                            <div className="mt-2 rounded-md border border-emerald-glow/30 bg-emerald-glow/5 p-2 text-[11px]">
                              <p className="flex items-center gap-1 text-[10px] font-medium text-emerald-glow">
                                <CheckCircle2 className="size-3" /> {isFa ? "پاسخ پشتیبانی" : "Support reply"}
                              </p>
                              <p className="mt-1 text-foreground">{tk.reply}</p>
                            </div>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground">{fmtRelative(tk.createdAt, lang)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* New ticket dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display">
              <Headset className="size-5 text-amber" /> {t("support.newTicket")}
            </DialogTitle>
            <DialogDescription>{t("support.subtitle")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">{t("support.ticketSubject")}</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1" placeholder={isFa ? "مثلاً: مشکل در پرداخت فاکتور" : "e.g. Invoice payment issue"} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">{isFa ? "دسته" : "Category"}</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{t(`support.category.${c}` as any) ?? c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{isFa ? "اولویت" : "Priority"}</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{t(`support.priority.${p}` as any) ?? p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">{t("support.ticketMessage")}</Label>
              <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="mt-1" placeholder={t("support.ticketMessagePlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={submit} disabled={submitting} className="bg-amber text-black hover:bg-amber/90">
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Plus className="mr-1.5 size-4" />}
              {t("support.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContactCard({ icon: Icon, title, desc, tone, onClick }: { icon: any; title: string; desc: string; tone: string; onClick: () => void }) {
  const toneClass: Record<string, string> = {
    amber: "border-amber/30 bg-amber/5 text-amber",
    emerald: "border-emerald-glow/30 bg-emerald-glow/5 text-emerald-glow",
    violet: "border-violet-400/30 bg-violet-400/5 text-violet-300",
  };
  return (
    <button onClick={onClick} className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-amber/40">
      <div className={`grid size-10 shrink-0 place-items-center rounded-lg border ${toneClass[tone] ?? toneClass.amber}`}>
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{desc}</p>
      </div>
    </button>
  );
}
