import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { isUniqueViolation } from "@/lib/db-errors";
import { sessions, users } from "@/db/schema";
import { cleanDisplayName, validateDisplayName } from "@/lib/user-profile";

/**
 * Minimal hand-rolled session auth.
 *
 * Deliberately not NextAuth/Clerk: the brief scopes auth as "minimal" and scores
 * simplicity, and this is ~100 lines with no provider config, no adapter layer
 * and no extra runtime dependency. It is boring on purpose — the interesting
 * engineering in this project is the thesis engine, and auth should cost the
 * reader as little attention as possible.
 */

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = "thesis_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/* ---------------------------------------------------------------- passwords */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = (await scryptAsync(password, Buffer.from(saltHex, "hex"), 64)) as Buffer;
  const expected = Buffer.from(keyHex, "hex");
  // Constant-time: a length mismatch must not short-circuit before the compare.
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/* ---------------------------------------------------------------- sessions */

/** We store only the hash, so a database leak does not hand over live sessions. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });

  // Opportunistic cleanup of this user's expired rows. Cheap, bounded, and it
  // saves us a cron job for something that does not deserve one.
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export type SessionUser = { id: number; email: string; displayName: string | null };

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0] ?? null;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

/* ---------------------------------------------------------------- accounts */

export type AuthResult = { ok: true; userId: number } | { ok: false; error: string };

const normaliseEmail = (email: string) => email.trim().toLowerCase();

export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email address.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export async function registerUser(email: string, password: string, displayName: string): Promise<AuthResult> {
  const invalid = validateDisplayName(displayName) ?? validateCredentials(email, password);
  if (invalid) return { ok: false, error: invalid };

  try {
    const [row] = await db
      .insert(users)
      .values({ email: normaliseEmail(email), passwordHash: await hashPassword(password), displayName: cleanDisplayName(displayName) })
      .returning({ id: users.id });
    return { ok: true, userId: row.id };
  } catch (err) {
    // Unique violation. Relying on the constraint rather than a prior SELECT
    // avoids the race where two concurrent signups both see "email is free".
    if (isUniqueViolation(err)) {
      return { ok: false, error: "An account with that email already exists." };
    }
    throw err;
  }
}

export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normaliseEmail(email)))
    .limit(1);

  // Same message and comparable work whether or not the account exists, so the
  // response does not reveal which emails are registered.
  if (!user) {
    await hashPassword(password);
    return { ok: false, error: "Email or password is incorrect." };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: "Email or password is incorrect." };
  }
  return { ok: true, userId: user.id };
}
