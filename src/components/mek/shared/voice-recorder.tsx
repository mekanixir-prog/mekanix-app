"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// VoiceRecorder — captures microphone audio via MediaRecorder API.
// Calls onRecorded(blob) when the user stops recording.
// `lang` is used for accessibility labels + UI strings ("fa" → Persian).
export function VoiceRecorder({
  lang = "en",
  onRecorded,
  className,
}: {
  lang?: "en" | "fa";
  onRecorded?: (blob: Blob, durationSec: number) => void;
  className?: string;
}) {
  const isFa = lang === "fa";
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startTsRef = useRef<number>(0);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [acquiring, setAcquiring] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      // cleanup on unmount
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const start = async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error(isFa ? "ضبط صدا در این مرورگر پشتیبانی نمی‌شود" : "Voice recording is not supported in this browser");
      return;
    }
    setAcquiring(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const duration = (Date.now() - startTsRef.current) / 1000;
        onRecorded?.(blob, duration);
        // stop mic tracks
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      recorderRef.current = mr;
      startTsRef.current = Date.now();
      setSeconds(0);
      mr.start();
      setRecording(true);
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s >= 180) {
            // 3-minute auto-stop safety
            stop();
            return s;
          }
          return s + 1;
        });
      }, 1000);
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        toast.error(isFa ? "دسترسی به میکروفون داده نشد" : "Microphone permission denied");
      } else {
        toast.error(isFa ? "ضبط صدا ناموفق بود" : "Could not start recording");
      }
    } finally {
      setAcquiring(false);
    }
  };

  const stop = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    setRecording(false);
  };

  const toggle = () => {
    if (recording) stop();
    else start();
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    if (isFa) {
      const map = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
      return `${pad(m)}:${pad(sec)}`.replace(/\d/g, (d) => map[Number(d)]);
    }
    return `${pad(m)}:${pad(sec)}`;
  };

  return (
    <Button
      type="button"
      variant={recording ? "default" : "ghost"}
      size="sm"
      onClick={toggle}
      disabled={acquiring}
      className={className}
      aria-label={isFa ? "ضبط صدا" : "Record voice note"}
      title={isFa ? "ضبط صدا" : "Record voice note"}
    >
      {acquiring ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : recording ? (
        <span className="inline-flex items-center gap-1">
          <motion.span
            animate={{ opacity: [1, 0.3, 1], scale: [1, 0.85, 1] }}
            transition={{ duration: 0.9, repeat: Infinity }}
            className="inline-block size-2.5 rounded-full bg-rose-500"
          />
          <Square className="size-3" />
          <span className="font-mono text-[10px] tabular-nums">{fmtTime(seconds)}</span>
        </span>
      ) : (
        <Mic className="size-3.5" />
      )}
      <AnimatePresence />
    </Button>
  );
}
