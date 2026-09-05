/**
 * The single timezone boundary in the app.
 *
 * Rule: every instant is stored and compared in UTC. A local zone appears only
 * here, at the rendering edge. Nothing outside this file formats a date for a
 * user.
 *
 * Why it matters for "since you last checked": the away-window is compared in
 * UTC because it is an interval between two instants. But the *labels* on it
 * ("Thursday", "since Tuesday's close") are exchange-local calendar facts.
 * Mixing the two is how you end up telling a user at 02:00 IST that nothing
 * happened "yesterday" when yesterday's session is the one they mean.
 *
 * EVERY EXCHANGE GETS ITS OWN CLOCK. A US security is not stale because the NSE
 * is shut, and a NASDAQ close stamped "15:30 IST" is simply wrong. The IST
 * helpers below stay because Indian securities still need Indian semantics; the
 * zoned helpers are what every other market renders through.
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

/** The IST calendar date of an instant, as YYYY-MM-DD. This is a trading-date key. */
export function istDate(at: Date): string {
  return dateFmt.format(at);
}

/** Minutes past IST midnight. */
export function istMinutes(at: Date): number {
  const [h, m] = timeFmt.format(at).split(":").map(Number);
  return h * 60 + m;
}

/**
 * "4 Sep, 14:32" in IST, always explicitly labelled as such in the UI.
 *
 * Kept for the Indian-market surfaces that genuinely mean IST — the digest
 * window, the ingestion batch clock. Anything describing a specific security
 * uses `formatExchangeTime` with that security's own zone instead.
 */
export function formatIST(at: Date): string {
  return formatInZone(at, IST);
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

/* ------------------------------------------------- exchange-local rendering */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Zone abbreviations are locale-dependent in a way that matters: only en-IN
 * renders Asia/Kolkata as "IST", and only en-US renders America/New_York as
 * "EDT". Everything else falls back to "GMT+5:30", which is correct but reads
 * like a bug. Pick the locale that names the zone the way its market does.
 */
function localeFor(timeZone: string): string {
  if (timeZone.startsWith("Asia/")) return "en-IN";
  if (timeZone.startsWith("America/")) return "en-US";
  return "en-GB";
}

const zonedFmt = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const id = `${key}|${timeZone}`;
  let fmt = zonedFmt.get(id);
  if (!fmt) {
    // An invalid zone must not take a page down: fall back to UTC and say so.
    try { fmt = new Intl.DateTimeFormat(localeFor(timeZone), { timeZone, ...options }); }
    catch { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }); }
    zonedFmt.set(id, fmt);
  }
  return fmt;
}

/** Numeric parts of an instant in a zone, so formatting never depends on locale. */
function zonedParts(at: Date, timeZone: string) {
  const parts = formatter(timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }, "parts").formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    year: get("year"), month: get("month"), day: get("day"),
    // Some locales render midnight as "24"; normalise so it is never "24:07".
    hour: String(Number(get("hour")) % 24).padStart(2, "0"),
    minute: get("minute"), second: get("second"),
  };
}

/** The exchange-local calendar date of an instant, as YYYY-MM-DD. A trading-date key. */
export function exchangeDate(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "4 Sep, 15:30" in the exchange's own zone. Always shown with its zone label. */
export function formatInZone(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${p.hour}:${p.minute}`;
}

/** "IST", "EDT", "UTC" — the zone abbreviation actually in force at that instant. */
export function zoneAbbreviation(at: Date, timeZone: string): string {
  const parts = formatter(timeZone, { timeZoneName: "short" }, "zone").formatToParts(at);
  // A zone with no common abbreviation reports "GMT+5:30". Either is honest.
  return parts.find((p) => p.type === "timeZoneName")?.value || "UTC";
}

/** "4 Sep, 15:30 IST" — a timestamp that says which clock it is on. */
export function formatExchangeTime(at: Date, timeZone: string): string {
  return `${formatInZone(at, timeZone)} ${zoneAbbreviation(at, timeZone)}`;
}

/** Offset of a zone from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUTC - at.getTime();
}

/**
 * The instant of a wall-clock time on a trading date, in the exchange's zone.
 *
 * This is what turns "the 2026-09-04 session close" into a UTC timestamp. It has
 * to be zone-aware rather than a fixed offset: America/New_York is UTC-4 in
 * September and UTC-5 in December, and a hardcoded offset would stamp half the
 * year's US sessions an hour wrong. For Asia/Kolkata it returns exactly the
 * 10:00Z that every already-stored Indian event was written with, so existing
 * event identities do not move.
 */
export function zonedInstant(date: string, timeZone: string, hours: number, minutes: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hours, minutes);
  // Two passes: the offset is looked up at the approximate instant, then again
  // at the corrected one, which settles the DST-boundary case.
  const first = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(first, timeZone));
}
