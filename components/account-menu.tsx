"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "@/components/theme-toggle";

/** Disclosure with native buttons/radios: normal Tab order, no simulated menu roles. */
export function AccountMenu({ name, email, logout }: { name: string | null; email: string; logout: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { theme, choose } = useTheme();
  const identity = name || email;
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="account-control" ref={root} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="user-identity account-trigger" aria-label="Account menu" aria-expanded={open} aria-controls="account-dropdown" onClick={() => setOpen(!open)}><span className="user-avatar" aria-hidden="true">{identity.slice(0, 1).toUpperCase()}</span><span title={identity}>{identity}</span><span aria-hidden="true">⌄</span></button>
    {open && <section id="account-dropdown" className="account-dropdown" aria-label="Your account"><div className="account-profile"><span className="user-avatar" aria-hidden="true">{identity.slice(0, 1).toUpperCase()}</span><strong>{identity}</strong><p>{email}</p></div><fieldset><legend>Appearance</legend><div className="appearance-options">{(["light", "dark"] as const).map((value) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme === value} onChange={() => choose(value)} /><span>{value[0].toUpperCase() + value.slice(1)}</span></label>)}</div></fieldset><div className="account-signout" onClick={() => { try { sessionStorage.removeItem("thesis-conversation"); } catch {} }}>{logout}</div></section>}
  </div>;
}
