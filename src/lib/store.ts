"use client";
// MEKANIX — global UI state (Zustand). Handles boot flow (splash → mode → app),
// phone-OTP auth, role-switch, machine-mode filter, and view navigation.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Role } from "./api";
import type { MachineMode } from "./constants";
import type { Lang } from "./i18n";

export type CustomerView =
  | "home"
  | "vehicles"
  | "request-type"
  | "describe"
  | "matching"
  | "technician-profile"
  | "track"
  | "invoice"
  | "invoice-document"
  | "completion"
  | "service-history"
  | "chat"
  | "notifications"
  | "settings"
  | "vip"
  | "support"
  | "fleet-dashboard"
  | "maintenance"
  | "referral"
  | "insurance";

export type TechView =
  | "dashboard"
  | "requests"
  | "job-detail"
  | "earnings"
  | "schedule"
  | "profile"
  | "reviews"
  | "notifications"
  | "chat";

export type AdminView =
  | "overview"
  | "customers"
  | "technicians"
  | "jobs"
  | "payments"
  | "withdrawals"
  | "reviews"
  | "disputes"
  | "categories"
  | "verification"
  | "applications"
  | "settings";

// Boot stages determine which top-level experience is shown.
export type BootStage = "splash" | "mode-select" | "app";

export type Portal = "customer" | "mechanic" | "admin";

interface AuthState {
  userId: string | null;
  phone: string | null;
  name: string | null;
  isGuest: boolean; // guest = no verified phone
  verified: boolean;
}

interface NavState {
  view: string;
  params: Record<string, any>;
  go: (view: string, params?: Record<string, any>) => void;
  back: () => void;
  reset: (view: string) => void;
}

interface AppState extends NavState {
  // Boot & portal
  bootStage: BootStage;
  portal: Portal; // which portal the user entered through
  // Profile completion gate
  profileCompleteRequired: boolean;
  setProfileCompleteRequired: (v: boolean) => void;
  // Onboarding gate — shows every time user enters app
  onboardingRequired: boolean;
  setOnboardingSeen: (v: boolean) => void;
  // Language
  lang: Lang;
  setLang: (lang: Lang) => void;
  // Auth
  auth: AuthState;
  signIn: (auth: Partial<AuthState>) => void;
  signOut: () => void;
  // Role (within app)
  role: Role;
  setRole: (role: Role) => void;
  // Machine mode filter (heavy vs passenger)
  machineMode: MachineMode;
  setMachineMode: (mode: MachineMode) => void;
  // Navigation
  history: { view: string; params: Record<string, any> }[];
  // Boot flow helpers
  enterApp: (portal: Portal, auth?: Partial<AuthState>) => void;
  exitToSplash: () => void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      bootStage: "splash",
      portal: "customer",
      profileCompleteRequired: false,
      setProfileCompleteRequired: (v) => set({ profileCompleteRequired: v }),
      onboardingRequired: true,
      setOnboardingSeen: () => set({ onboardingRequired: false }),
      lang: "fa" as Lang,
      auth: { userId: null, phone: null, name: null, isGuest: false, verified: false },
      role: "CUSTOMER",
      machineMode: "heavy",
      view: "home",
      params: {},
      history: [],

      setLang: (lang) => set({ lang }),

      signIn: (patch) => set((s) => ({ auth: { ...s.auth, ...patch } })),
      signOut: () =>
        set({
          bootStage: "splash",
          portal: "customer",
          auth: { userId: null, phone: null, name: null, isGuest: false, verified: false },
          role: "CUSTOMER",
          view: "home",
          params: {},
          history: [],
        }),

      setRole: (role) =>
        set({
          role,
          view: role === "CUSTOMER" ? "home" : role === "TECHNICIAN" ? "dashboard" : "overview",
          params: {},
          history: [],
        }),

      setMachineMode: (mode) => set({ machineMode: mode }),

      // After splash auth → go to mode-select (customer) or straight to app (mechanic/admin)
      enterApp: (portal, auth) =>
        set((s) => ({
          portal,
          auth: auth ? { ...s.auth, ...auth } : s.auth,
          bootStage: portal === "customer" ? "mode-select" : "app",
          role: portal === "mechanic" ? "TECHNICIAN" : portal === "admin" ? "ADMIN" : "CUSTOMER",
          view: portal === "mechanic" ? "dashboard" : portal === "admin" ? "overview" : "home",
          params: {},
          history: [],
          onboardingRequired: true,
        })),

      exitToSplash: () => {
        // Clear JWT token from localStorage on sign-out
        if (typeof window !== "undefined") {
          localStorage.removeItem("mekanix-token");
        }
        set({
          bootStage: "splash",
          auth: { userId: null, phone: null, name: null, isGuest: false, verified: false },
          view: "home",
          params: {},
          history: [],
          profileCompleteRequired: false,
          onboardingRequired: true,
        });
      },

      go: (view, params = {}) => {
        const { view: cur, params: curParams, history } = get();
        set({ view, params, history: [...history, { view: cur, params: curParams }].slice(-30) });
      },
      back: () => {
        const { history } = get();
        if (history.length === 0) return;
        const last = history[history.length - 1];
        set({ view: last.view, params: last.params, history: history.slice(0, -1) });
      },
      reset: (view) => set({ view, params: {}, history: [] }),
    }),
    { name: "mekanix-app" }
  )
);
