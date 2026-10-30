"use client";
import { useEffect, useState } from "react";
import { WalletCards, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { isValidIranianSheba } from "@/lib/iranian-iban";

type Row = {
  id: string; code: string; amount: number | string; method: string;
  cardNumber: string | null; bankName: string | null; shebaNumber: string | null;
  status: "REQUESTED" | "APPROVED" | "PAID" | "REJECTED"; requestedAt: string;
  adminNotes: string | null;
  wallet: { technician: { user: { name: string } } };
};

export function AdminWithdrawals() {
  const { t, isFa, money, lang } = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try { setRows(await api.adminList("withdrawals") as Row[]); }
    catch { setRows([]); toast.error(t("admin.withdrawals.loadFailed")); }
  };
  useEffect(() => { void load(); }, []);

  const act = async (row: Row, status: "APPROVED" | "REJECTED" | "PAID") => {
    const message = status === "PAID" ? t("admin.withdrawals.confirmPaid")
      : status === "REJECTED" ? t("admin.withdrawals.confirmReject")
      : t("admin.withdrawals.confirmApprove");
    if (!window.confirm(message)) return;
    setBusy(row.id);
    try {
      await api.adminUpdate("withdrawals", row.id, { status });
      toast.success(t(`admin.withdrawals.toast.${status}`));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("admin.withdrawals.actionFailed"));
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.withdrawals.title")} subtitle={t("admin.withdrawals.subtitle")} />
      {rows === null ? <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
        : rows.length === 0 ? <EmptyState icon={WalletCards} title={t("admin.withdrawals.empty")} />
        : <div className="space-y-3">{rows.map((row) => (
          <article key={row.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><span className="font-mono text-xs">{row.code}</span><Badge variant={row.status === "PAID" ? "default" : row.status === "REJECTED" ? "destructive" : "secondary"}>{t(`admin.withdrawals.status.${row.status}`)}</Badge></div>
                <p className="mt-1 font-semibold">{row.wallet?.technician?.user?.name ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{fmtDateTime(row.requestedAt, lang)} · {t(`pay.${row.method}`, row.method)}</p>
              </div>
              <p className="font-bold tabular-nums text-amber">{money(Number(row.amount))}</p>
            </div>
            <div className="mt-3 rounded-lg bg-muted/40 p-3 text-xs">
              <p>{t("admin.withdrawals.destination")}: {row.method === "bank" ? row.shebaNumber || "—" : row.cardNumber || "—"}</p>
              <p>{t("admin.withdrawals.bank")}: {row.bankName || "—"}</p>
              {row.adminNotes && <p>{t("admin.withdrawals.adminNote")}: {row.adminNotes}</p>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {row.status === "REQUESTED" && <>
                <Button size="sm" disabled={busy === row.id} onClick={() => act(row, "APPROVED")}>{t("admin.withdrawals.approve")}</Button>
                <Button size="sm" variant="destructive" disabled={busy === row.id} onClick={() => act(row, "REJECTED")}>{t("admin.withdrawals.reject")}</Button>
              </>}
              {row.status === "APPROVED" && <>
                {row.method === "bank" && isValidIranianSheba(row.shebaNumber) ? (
                  <Button size="sm" disabled={busy === row.id} onClick={() => act(row, "PAID")}>{busy === row.id ? t("common.loading") : t("admin.withdrawals.markPaid")}</Button>
                ) : (
                  <p className="w-full text-xs text-muted-foreground">{t("admin.withdrawals.destinationRequired")}</p>
                )}
                <Button size="sm" variant="destructive" disabled={busy === row.id} onClick={() => act(row, "REJECTED")}>{t("admin.withdrawals.reject")}</Button>
              </>}
            </div>
          </article>
        ))}</div>}
    </div>
  );
}
