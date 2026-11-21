"use client";
import { useEffect, useState } from "react";
import { Layers, Loader2, Plus, Save } from "lucide-react";
import { api, type ServiceCategory } from "@/lib/api";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { MekIcon } from "@/components/mek/shared/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useT } from "@/lib/use-t";

export function AdminCategories() {
  const { t, isFa, money } = useT();
  const [rows, setRows] = useState<ServiceCategory[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { name: string; basePrice: number; active: boolean }>>({});

  const load = () => { api.adminList("categories").then(setRows).catch(() => setRows([])); };
  useEffect(() => { load(); }, []);

  const update = (c: ServiceCategory, patch: Partial<{ name: string; basePrice: number; active: boolean }>) => {
    setRows((prev) => prev?.map((x) => x.id === c.id ? { ...x, name: patch.name ?? x.name, active: patch.active ?? x.active } : x) ?? null);
    setDrafts((d) => ({ ...d, [c.id]: { name: patch.name ?? c.name, basePrice: patch.basePrice ?? Number(c.basePrice), active: patch.active ?? c.active } }));
  };

  const save = async (c: ServiceCategory) => {
    const draft = drafts[c.id];
    if (!draft) return;
    try {
      await api.adminUpdate("categories", c.id, draft);
      toast.success(t("admin.categories.savedToastName").replace("{name}", draft.name));
      setDrafts((d) => { const n = { ...d }; delete n[c.id]; return n; });
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.categories.title")} subtitle={t("admin.categories.subtitle")} action={<Button className="bg-amber text-black hover:bg-amber/90" onClick={() => toast.info(t("admin.categories.createInfo"))}><Plus className="mr-1.5 size-4" /> {t("admin.categories.new")}</Button>} />
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Layers} title={t("admin.categories.empty")} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((c) => {
            const dirty = drafts[c.id];
            return (
              <div key={c.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="grid size-10 place-items-center rounded-lg border border-border bg-background">
                    <MekIcon name={c.icon} className="size-5 text-amber" />
                  </div>
                  <Switch checked={c.active} onCheckedChange={(v) => update(c, { active: v })} />
                </div>
                <Input value={c.name} onChange={(e) => update(c, { name: e.target.value })} className="mt-3 h-8 text-sm" />
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">{t("admin.categories.col.basePrice")}</span>
                  <Input value={Number(c.basePrice)} onChange={(e) => update(c, { basePrice: parseFloat(e.target.value) || 0 })} type="number" className="h-8 text-xs" />
                </div>
                <Button size="sm" disabled={!dirty} onClick={() => save(c)} className="mt-3 w-full bg-amber text-black hover:bg-amber/90 disabled:opacity-40">
                  <Save className="mr-1.5 size-3.5" /> {dirty ? t("admin.categories.save") : t("admin.categories.saved")}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
