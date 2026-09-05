/** Names are identity text only, never a market/thesis input. */
export function cleanDisplayName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
export function validateDisplayName(value: string): string | null {
  const name = cleanDisplayName(value);
  if (!name) return "Enter your name.";
  if (name.length > 80 || /[\p{Cc}]/u.test(name)) return "Use a name of 80 characters or fewer.";
  return null;
}
/** The name a user is addressed by. Never derived from an email address. */
export function firstName(name: string | null | undefined): string | null {
  const clean = (name ?? "").trim();
  return clean ? clean.split(/\s+/u)[0] : null;
}

/**
 * "Good evening, Tanisha" — or "Welcome back" for an account with no name.
 *
 * `timeZone` is the zone the greeting is computed in: the server renders it in
 * IST, and the browser re-renders it in the reader's own zone once mounted, so a
 * user in New York is not told good evening at breakfast. An account predating
 * the name field falls back rather than inventing a name from its email.
 */
export function homeGreeting(name: string | null, now = new Date(), timeZone: string | undefined = "Asia/Kolkata"): string {
  const first = firstName(name);
  if (!first) return "Welcome back";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${period}, ${first}`;
}
