"use client";
import { useEffect, useState } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Job } from "@/lib/api";
import { ChatPanel } from "@/components/mek/shared/chat-panel";
import { EmptyState } from "@/components/mek/shared/primitives";
import { useT } from "@/lib/use-t";

export function CustomerChat({ customer }: { customer: DemoUser }) {
  const { go, params } = useApp();
  const { t, isFa } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.jobId) return;
    let cancelled = false;
    api.getJob(params.jobId).then((j) => { if (!cancelled) setJob(j); }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [params.jobId]);

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  if (!job) return <EmptyState icon={MessageSquare} title={t("tech.chat.empty")} description={t("tech.chat.empty")} />;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" dir={isFa ? "rtl" : "ltr"} style={{ height: "calc(100vh - 8rem)" }}>
      <ChatPanel
        job={job}
        currentUserId={customer.id}
        otherName={job.technician.user.name}
        otherAvatar={job.technician.user.avatar ?? undefined}
      />
    </div>
  );
}
