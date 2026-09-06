"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui";

/**
 * Appearance: light, dark and aurora, stored per browser.
 *
 * There is still no "system" option. It made the product's own look a coin toss
 * — the same account rendering differently on two machines with nobody having
 * chosen either — and a preference written before that change resolves to dark
 * and is rewritten in place, so an existing user is never left on a value the
 * UI can no longer show.
 *
 * Aurora is a third CHOICE, not a third code path: it is the same markup and the
 * same layout under a different set of tokens, so nothing in the product can
 * behave differently because of which one is selected.
 */
export const THEME_KEY = "thesis-theme";
export const THEMES = ["light", "dark", "aurora"] as const;
export type Theme = (typeof THEMES)[number];
const DEFAULT_THEME: Theme = "dark";

const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);

function storedTheme(): Theme {
  let saved: string | null = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage may be disabled */ }
  if (isTheme(saved)) return saved;
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
  // Cycles, so every appearance is reachable from the sign-in screen too.
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  return <button type="button" className="icon-button theme-toggle" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => choose(next)}>
    <span className="theme-sun"><Icon name="sun" /></span><span className="theme-moon"><Icon name="moon" /></span>
  </button>;
}
