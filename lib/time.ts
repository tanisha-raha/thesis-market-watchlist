/**
 * The single timezone boundary in the app.
 *
 * Rule: every instant is stored and compared in UTC. IST appears only here, at
 * the rendering edge. Nothing outside this file formats a date for a user.
 *
 * Why it matters for "since you last checked": the away-window is compared in
 * UTC because it is an interval between two instants. But the *labels* on it
 * ("Thursday", "since Tuesday's close") are IST calendar facts. Mixing the two
 * is how you end up telling a user at 02:00 IST that nothing happened
 * "yesterday" when yesterday's session is the one they mean.
 */

export const IST = "Asia/Kolkata";

/** NSE regular session, IST. Used to decide whether an instant is mid-session. */
export const SESSION_OPEN_MINUTES = 9 * 60 + 15;  // 09:15 IST
export const SESSION_CLOSE_MINUTES = 15 * 60 + 30; // 15:30 IST

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false,
});
const fullFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});

/** The IST calendar date of an instant, as YYYY-MM-DD. This is a trading-date key. */
export function istDate(at: Date): string {
  return dateFmt.format(at);
}

/** Minutes past IST midnight. */
export function istMinutes(at: Date): number {
  const [h, m] = timeFmt.format(at).split(":").map(Number);
  return h * 60 + m;
}

/** "4 Sep, 14:32" — always IST, always explicitly labelled as such in the UI. */
export function formatIST(at: Date): string {
  return fullFmt.format(at);
}

/**
 * Relative age, for freshness labels. Deliberately coarse: claiming
 * "6 seconds ago" on a feed that advertises a 15-minute delay would be a
 * precision we do not have.
 */
export function formatAge(at: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Is this instant inside the NSE regular session, by IST wall clock? */
export function isWithinSessionHours(at: Date): boolean {
  const mins = istMinutes(at);
  return mins >= SESSION_OPEN_MINUTES && mins <= SESSION_CLOSE_MINUTES;
}
