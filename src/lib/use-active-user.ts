"use client";
import { useEffect, useState } from "react";
import type { User, Customer, Technician } from "./api";
import { useApp } from "./store";

export type DemoUser = User & { customer?: Customer | null; technician?: Technician | null };

export function useActiveUser() {
  const role = useApp((s) => s.role);
  const authUserId = useApp((s) => s.auth.userId);
  const exitToSplash = useApp((s) => s.exitToSplash);
  const [state, setState] = useState<{ user: DemoUser | null; loadedKey: string | null }>({
    user: null,
    loadedKey: null,
  });

  useEffect(() => {
    let cancelled = false;
    const key = authUserId ?? `demo:${role}`;
    const run = async () => {
      try {
        let data: any;
        if (authUserId) {
          // Authenticated user — attach JWT token
          const token = typeof window !== "undefined" ? localStorage.getItem("mekanix-token") : null;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (token) headers["Authorization"] = `Bearer ${token}`;

          const res = await fetch("/api/auth/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ userId: authUserId }),
          });

          // If 401 — token is invalid/expired — force logout
          if (res.status === 401) {
            if (typeof window !== "undefined") {
              localStorage.removeItem("mekanix-token");
            }
            exitToSplash();
            return;
          }

          data = await res.json();
          if (!data.user) data = { [role]: null };
          const u = data.user as DemoUser | undefined;
          if (!cancelled) setState({ user: u ?? null, loadedKey: key });
        } else {
          // Guest/demo user — no auth needed
          const res = await fetch("/api/auth/demo");
          data = await res.json();
          if (cancelled) return;
          const u = (data[role] as DemoUser | undefined) ?? null;
          setState({ user: u, loadedKey: key });
        }
      } catch {
        if (!cancelled) setState({ user: null, loadedKey: key });
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [role, authUserId, exitToSplash]);

  return { user: state.user, loading: state.loadedKey !== (authUserId ?? `demo:${role}`), role };
}
