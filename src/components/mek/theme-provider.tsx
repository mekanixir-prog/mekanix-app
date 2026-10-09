"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";

/**
 * ThemeProvider — minimal replacement for next-themes' ThemeProvider.
 *
 * Why we don't use next-themes anymore: Next.js 16 (Turbopack) throws
 * "Encountered a script tag while rendering React component" because
 * next-themes internally renders <script dangerouslySetInnerHTML> to inject
 * a theme-bootstrap script. That pattern is forbidden in React 19+ client
 * rendering. Rather than fight the library, we ship a minimal provider that
 * persists the theme to localStorage and toggles a class on <html>.
 *
 * API parity with next-themes for our existing callers:
 *   - useTheme() returns { theme, setTheme, resolvedTheme }
 *   - "light" | "dark" values
 *   - No FOUC risk in our app because defaultTheme="light" is set on <html>
 *     via the server-rendered HTML (the class is always present).
 */

type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme | undefined;
  resolvedTheme: Theme | undefined;
  setTheme: (t: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: undefined,
  resolvedTheme: undefined,
  setTheme: () => {},
});

const STORAGE_KEY = "theme";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  enableSystem = false,
  storageKey = STORAGE_KEY,
  ..._rest
}: {
  children: ReactNode;
  defaultTheme?: Theme;
  enableSystem?: boolean;
  storageKey?: string;
  // Accept (and ignore) any other props next-themes would have accepted, so
  // existing call sites don't need to change.
  [key: string]: unknown;
}) {
  const [theme, setThemeState] = useState<Theme | undefined>(undefined);

  // Initialize from localStorage on mount (client-only).
  useEffect(() => {
    let initial: Theme = defaultTheme;
    try {
      const stored = localStorage.getItem(storageKey) as Theme | null;
      if (stored === "light" || stored === "dark") {
        initial = stored;
      } else if (enableSystem) {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        initial = prefersDark ? "dark" : "light";
      }
    } catch {
      // localStorage not available — fall back to defaultTheme.
    }
    setThemeState(initial);
    applyTheme(initial);
  }, [defaultTheme, enableSystem, storageKey]);

  // Listen for cross-tab storage changes.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey) return;
      const next = (e.newValue as Theme) || defaultTheme;
      if (next === "light" || next === "dark") {
        setThemeState(next);
        applyTheme(next);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey, defaultTheme]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      applyTheme(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // Ignore — storage might be unavailable (private mode, etc).
      }
    },
    [storageKey]
  );

  const value: ThemeContextValue = {
    theme,
    resolvedTheme: theme,
    setTheme,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
