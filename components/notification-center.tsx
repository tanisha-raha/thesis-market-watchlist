"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui";

/**
 * The notification centre.
 *
 * WHY IT FETCHES INSTEAD OF BEING RENDERED. Deriving notifications reads
 * committed thesis verdicts and change events, and this product spent real
 * effort getting that kind of work out from between a click and a rendered page.
 * So the bell mounts with the rest of the chrome and asks afterwards; the
 * endpoint's write is idempotent, so asking often costs nothing.
 *
 * Every line shown here comes from a stored row. There is no text generated
 * about a company, no live price, and no signal that is not already evidence.
 */

export type NotificationItem = {
  id: number;
  symbol: string;
  type: string;
  health: string | null;
  reason: string;
  link: string;
  occurredAt: string;
  readAt: string | null;
};

const HEADLINE: Record<string, string> = {
  STRONG: "THESIS STRONG",
  NEEDS_ATTENTION: "THESIS NEEDS ATTENTION",
  MATERIALLY_WEAKENED: "THESIS MATERIALLY WEAKENED",
  INVALIDATED: "THESIS INVALIDATED",
};
const TYPE_HEADLINE: Record<string, string> = {
  CONDITION_TRIGGERED: "CONDITION TRIGGERED",
  THESIS_MATERIALLY_WEAKENED: "THESIS MATERIALLY WEAKENED",
  THESIS_INVALIDATED: "THESIS INVALIDATED",
  TRIGGER_REVERSED: "TRIGGER REVERSED",
  MISSED_EVENT: "MISSED EVENT",
};
const TONE: Record<string, string> = {
  STRONG: "strong", NEEDS_ATTENTION: "attention",
  MATERIALLY_WEAKENED: "weakened", INVALIDATED: "invalidated",
};

/** Relative, and coarse: the exact instant is on the evidence it links to. */
function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications");
      if (!response.ok) return;
      const payload = await response.json() as { items: NotificationItem[]; unread: number };
      setItems(payload.items); setUnread(payload.unread);
    } catch { /* the rest of the product is unaffected */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const readAll = async () => {
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnread(0);
    try { await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read-all" }) }); }
    catch { /* the next load restores the true state */ }
  };

  const openItem = async (item: NotificationItem) => {
    setOpen(false);
    if (item.readAt) return;
    setItems((current) => current.map((row) => row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row));
    setUnread((count) => Math.max(0, count - 1));
    try { await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", id: item.id }) }); }
    catch { /* the next load restores the true state */ }
  };

  return <div className="notification-control" ref={root} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="icon-button notification-trigger"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      aria-expanded={open} aria-controls="notification-panel"
      onClick={() => { setOpen(!open); if (!open) void load(); }}>
      <Icon name="bell" size={17} />
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
    </button>
    {open && <section id="notification-panel" className="notification-panel" aria-label="Notifications">
      <header>
        <strong>Notifications</strong>
        {unread > 0 && <button type="button" className="notification-readall" onClick={readAll}>Mark all as read</button>}
      </header>
      {items.length === 0
        ? <div className="notification-empty">
            <Icon name="shield" size={20} />
            <p>{loaded ? "Nothing needs your attention." : "Checking…"}</p>
            <small>THESIS tells you when a condition you wrote down changes — never when a price simply moved.</small>
          </div>
        : <ul className="notification-list">
            {items.map((item) => <li key={item.id} className={item.readAt ? "" : "is-unread"}>
              <Link href={item.link} onClick={() => void openItem(item)}>
                <span className="notification-head">
                  <strong className="num">{item.symbol}</strong>
                  <span className={`health-badge ${TONE[item.health ?? ""] ?? "attention"}`}>
                    {(item.health && HEADLINE[item.health]) ?? TYPE_HEADLINE[item.type] ?? "UPDATE"}
                  </span>
                </span>
                <p>{item.reason}</p>
                <span className="notification-foot">
                  <time dateTime={item.occurredAt}>{ago(item.occurredAt)}</time>
                  <span>{item.link === "/digest" ? "View evidence" : "Review thesis"} <Icon name="arrow" size={13} /></span>
                </span>
              </Link>
            </li>)}
          </ul>}
      <p className="notification-caption">Thesis Health evaluates the condition you stated, not the company or its expected return.</p>
    </section>}
  </div>;
}
