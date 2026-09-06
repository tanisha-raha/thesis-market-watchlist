"use client";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { THEMES, useTheme } from "@/components/theme-toggle";
import { saveDisplayName } from "@/app/actions";
import { Icon } from "@/components/ui";
import type { FormState } from "@/app/actions";

/**
 * The account control, addressed by name.
 *
 * An email address in the header is an identifier, not an identity: THESIS knows
 * who this is, so it says so. The stored display name is the only source — an
 * account created before names existed reads "Account" rather than having a name
 * invented from the local part of its email, and can supply one here in a single
 * field rather than through a profile system it does not otherwise need.
 *
 * Disclosure with native buttons/radios: normal Tab order, no simulated menu roles.
 */
type Preferences = { inApp: boolean; onTrigger: boolean; onNeedsAttention: boolean; onWeakened: boolean; onInvalidated: boolean; onReversal: boolean };

/** The five things worth being told, in the order they escalate. */
const SIGNALS: [keyof Preferences, string][] = [
  ["onTrigger", "My condition triggers"],
  ["onNeedsAttention", "My thesis needs attention"],
  ["onWeakened", "My thesis materially weakens"],
  ["onInvalidated", "My thesis is invalidated"],
  ["onReversal", "A trigger reverses while I’m away"],
];

export function AccountMenu({ name, email, logout }: { name: string | null; email: string; logout: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { theme, choose } = useTheme();
  const [nameState, saveName, savingName] = useActionState<FormState, FormData>(saveDisplayName, undefined);
  const displayName = name?.trim() || null;
  const label = displayName ?? "Account";
  // Fetched after mount, so the shell renders without waiting and the menu is
  // never briefly showing defaults over a preference somebody actually set.
  useEffect(() => {
    if (preferences) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/notifications");
        if (!response.ok) return;
        const payload = await response.json() as { preferences: Preferences };
        if (live) setPreferences(payload.preferences);
      } catch { /* preferences simply stay unshown */ }
    })();
    return () => { live = false; };
  }, [preferences]);

  const setPreference = async (key: keyof Preferences, value: boolean) => {
    setPreferences((current) => current && { ...current, [key]: value });
    try {
      // keepalive: a preference toggled just before navigating still lands.
      await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preferences: { [key]: value } }), keepalive: true });
    } catch { /* the next open reloads the stored truth */ }
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const avatar = displayName
    ? <span className="user-avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
    // No initial rather than a letter taken from an email address.
    : <span className="user-avatar" aria-hidden="true"><Icon name="user" size={15} /></span>;

  return <div className="account-control" ref={root} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="user-identity account-trigger" aria-label="Account menu" aria-expanded={open} aria-controls="account-dropdown" onClick={() => setOpen(!open)}>
      {avatar}<span title={label}>{label}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <section id="account-dropdown" className="account-dropdown" aria-label="Your account">
      <div className="account-profile">{avatar}<strong>{label}</strong><p>{email}</p></div>
      {!displayName && <form action={saveName} className="account-name">
        <label htmlFor="account-display-name">Add your name</label>
        <div>
          <input id="account-display-name" name="displayName" maxLength={80} autoComplete="name" placeholder="Your name" required />
          <button className="button-secondary" disabled={savingName}>{savingName ? "Saving…" : "Save"}</button>
        </div>
        {nameState?.error && <small role="alert">{nameState.error}</small>}
      </form>}
      <fieldset><legend>Appearance</legend><div className="appearance-options">{THEMES.map((value) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme === value} onChange={() => choose(value)} /><span>{value[0].toUpperCase() + value.slice(1)}</span></label>)}</div></fieldset>
      <fieldset className="account-notifications"><legend>Notifications</legend>
        <label className="notify-toggle">
          <span>In-app notifications</span>
          <input type="checkbox" name="inApp" checked={preferences?.inApp ?? true} disabled={!preferences}
            onChange={(e) => void setPreference("inApp", e.target.checked)} />
        </label>
        <p className="notify-heading">Notify me when</p>
        <div className="notify-options">{SIGNALS.map(([key, label]) => <label key={key}>
          <input type="checkbox" name={key} checked={preferences?.[key] ?? true} disabled={!preferences || !preferences.inApp}
            onChange={(e) => void setPreference(key, e.target.checked)} />
          <span>{label}</span>
        </label>)}</div>
        {/*
          Channel-aware, and honest about it. WhatsApp needs a provider account,
          a verified business sender, approved templates and explicit opt-in;
          none of that is configured, so the row says so rather than implying a
          message would ever be sent.
        */}
        <label className="notify-toggle is-unavailable">
          <span>WhatsApp alerts</span>
          <span className="status-badge neutral">UNAVAILABLE</span>
        </label>
        <small>WhatsApp delivery is not configured for this deployment. Nothing is sent anywhere until you opt in.</small>
      </fieldset>
      <div className="account-signout" onClick={() => { try { sessionStorage.removeItem("thesis-conversation"); } catch {} }}>{logout}</div>
    </section>}
  </div>;
}
