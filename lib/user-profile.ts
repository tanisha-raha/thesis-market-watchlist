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
export function homeGreeting(name: string | null, now = new Date()): string {
  if (!name?.trim()) return "Welcome back";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", hourCycle: "h23" }).format(now));
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${period}, ${name.trim().split(/\s+/u)[0]}`;
}
