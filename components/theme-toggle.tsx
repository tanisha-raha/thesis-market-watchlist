"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui";

/**
 * Appearance: exactly light and dark, stored per browser.
 *
 * There is no "system" option. It made the product's own look a coin toss —
 * the same account rendering differently on two machines with nobody having
 * chosen either — and a preference written before this change resolves to dark
 * and is rewritten in place, so an existing user is never left on a value the
 * UI can no longer show.
 */
export const THEME_KEY = "thesis-theme";
export type Theme = "light" | "dark";
const DEFAULT_THEME: Theme = "dark";

function storedTheme(): Theme {
  let saved: string | null = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage may be disabled */ }
  if (saved === "light" || saved === "dark") return saved;
  // Legacy "system" (or anything else) migrates to dark, once, on read.
  if (saved != null) { try { localStorage.setItem(THEME_KEY, DEFAULT_THEME); } catch { /* preference still applies */ } }
  return DEFAULT_THEME;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  useEffect(() => {
    const sync = () => {
      const next = storedTheme();
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("thesis-theme-change", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("thesis-theme-change", sync); };
  }, []);
  const choose = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); window.dispatchEvent(new Event("thesis-theme-change")); } catch { /* document preference still works */ }
  };
  return { theme, choose };
}

export function ThemeToggle() {
  const { theme, choose } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return <button type="button" className="icon-button theme-toggle" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => choose(next)}>
    <span className="theme-sun"><Icon name="sun" /></span><span className="theme-moon"><Icon name="moon" /></span>
  </button>;
}
