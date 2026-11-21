"use client";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, ImagePlus, Mic, Wrench, CheckCheck } from "lucide-react";
import { api, type Message, type Job } from "@/lib/api";
import { fmtTime, toPersianDigits } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useT } from "@/lib/use-t";

export function ChatPanel({
  job,
  currentUserId,
  otherName,
  otherAvatar,
  className,
}: {
  job: Job;
  currentUserId: string;
  otherName: string;
  otherAvatar?: string;
  className?: string;
}) {
  const { t, isFa, lang } = useT();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const data = await api.listMessages(job.id).catch(() => []);
    setMessages(data);
  }, [job.id]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const draft = text.trim();
    setText("");
    try {
      const msg = await api.sendMessage(job.id, draft, currentUserId);
      setMessages((prev) => [...(prev ?? []), msg]);
    } catch (e: any) {
      setText(draft);
      toast.error(e.message ?? t("tech.chat.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const codeText = isFa ? toPersianDigits(job.code) : job.code;

  return (
    <div className={cn("flex h-full flex-col", className)} dir={isFa ? "rtl" : "ltr"}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="relative">
          <div className="grid size-8 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
            {otherAvatar ? (
              <img src={otherAvatar} alt={otherName} className="size-full object-cover" />
            ) : (
              <span className="text-[11px] font-semibold">{otherName[0]}</span>
            )}
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-glow" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{otherName}</p>
          <p className="text-[10px] text-emerald-glow">{t("common.onlineDot")} · {codeText}</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-2/3" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {messages.map((m) => {
                const mine = m.fromUserId === currentUserId;
                const isSystem = m.kind === "system";
                if (isSystem) {
                  return (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="mx-auto flex max-w-md items-center gap-2 rounded-full border border-border bg-muted/60 px-3 py-1 text-center text-[11px] text-muted-foreground"
                    >
                      <Wrench className="size-3 text-amber" />
                      <span>{m.body}</span>
                      <span className="font-mono text-[9px]">{fmtTime(m.createdAt, lang)}</span>
                    </motion.div>
                  );
                }
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn("flex", mine ? "justify-end" : "justify-start")}
                  >
                    <div
                      className={cn(
                        "max-w-[78%] rounded-2xl px-3 py-2 text-[13px]",
                        mine
                          ? "rounded-br-sm bg-amber text-black"
                          : "rounded-bl-sm border border-border bg-card text-foreground"
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <div className={cn("mt-0.5 flex items-center gap-1 text-[9px]", mine ? "text-black/60" : "text-muted-foreground")}>
                        <span>{fmtTime(m.createdAt, lang)}</span>
                        {mine && <CheckCheck className="size-3" />}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-2">
          <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={() => toast.info(t("tech.chat.photoUploadReady"))}>
            <ImagePlus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={() => toast.info(t("tech.chat.voiceMock"))}>
            <Mic className="size-4" />
          </Button>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t("tech.chat.placeholder")}
            rows={1}
            className="min-h-[36px] max-h-24 resize-none"
          />
          <Button onClick={send} disabled={!text.trim() || sending} className="size-9 shrink-0 bg-amber text-black hover:bg-amber/90">
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
