"use client";
import { useEffect } from "react";

export function AccentThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;

    const applyAccent = (mode: string) => {
      const color = mode === "passenger" ? "#3D9B68" : "#F38E00";
      const cls = mode === "passenger" ? "accent-passenger" : "accent-heavy";
      root.classList.remove("accent-passenger", "accent-heavy");
      root.classList.add(cls);
      root.style.setProperty("--amber", color);
      root.style.setProperty("--amber-foreground", "#ffffff");
      root.style.setProperty("--color-amber", color);
      root.style.setProperty("--color-amber-foreground", "#ffffff");
    };

    const check = () => {
      try {
        const stored = JSON.parse(localStorage.getItem("mekanix-app") || "{}");
        const mode = stored?.state?.machineMode || "heavy";
        applyAccent(mode);
      } catch {
        /* ignore parse errors */
      }
    };

    check();
    const interval = setInterval(check, 200);
    return () => clearInterval(interval);
  }, []);

  return <>{children}</>;
}
