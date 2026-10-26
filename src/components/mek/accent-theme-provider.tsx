"use client";
import { useEffect } from "react";
import { useApp } from "@/lib/store";

/**
 * AccentThemeProvider — applies the correct accent color based on the
 * current machineMode in the Zustand store:
 *   - heavy (default): amber #F58220
 *   - passenger: emerald #3D9B68
 *
 * This provider subscribes DIRECTLY to the store (not localStorage polling)
 * so it reacts immediately when the user changes mode, language, or any
 * other state that might affect the accent. The previous version polled
 * localStorage every 200ms which was unreliable — it could miss updates
 * or apply the wrong accent if the store state diverged from localStorage.
 */
export function AccentThemeProvider({ children }: { children: React.ReactNode }) {
  // Subscribe to machineMode directly from the store — this re-renders
  // whenever machineMode changes, so the accent is always in sync.
  const machineMode = useApp((s) => s.machineMode);

  useEffect(() => {
    const root = document.documentElement;
    const mode = machineMode || "heavy"; // default to heavy (brand priority)
    const color = mode === "passenger" ? "#3D9B68" : "#F58220";
    const cls = mode === "passenger" ? "accent-passenger" : "accent-heavy";

    root.classList.remove("accent-passenger", "accent-heavy");
    root.classList.add(cls);
    root.style.setProperty("--amber", color);
    root.style.setProperty("--amber-foreground", "#ffffff");
    root.style.setProperty("--color-amber", color);
    root.style.setProperty("--color-amber-foreground", "#ffffff");
  }, [machineMode]); // re-run whenever machineMode changes

  return <>{children}</>;
}
