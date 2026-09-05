"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authenticate, createSession, destroySession, getSessionUser, registerUser } from "@/lib/auth";
import { addSymbol, removeSymbol } from "@/lib/watchlist";
import { acknowledgeThesis, createThesis, creationContext } from "@/lib/thesis";
import { advanceDigestWatermark } from "@/lib/digest";
import { lastCommittedBatchAt } from "@/lib/ingestion";
import type { ThesisType } from "@/lib/thesis-engine";

export type FormState = { error?: string } | undefined;

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    const result = await authenticate(email, password);
    if (!result.ok) return { error: result.error };
    await createSession(result.userId);
  } catch {
    return { error: "We couldn’t sign you in right now. Please try again." };
  }
  // Home previews attention without acknowledging the full digest.
  redirect("/");
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("displayName") ?? "");
  try {
    const result = await registerUser(email, password, displayName);
    if (!result.ok) return { error: result.error };
    await createSession(result.userId);
  } catch {
    return { error: "We couldn’t create your account right now. Please try again." };
  }
  redirect("/");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}

/**
 * Adds a symbol, optionally with the reason for watching it.
 *
 * The thesis question never blocks the add. Submitting the form untouched
 * records `none` and the symbol is on the watchlist — one click. A user who
 * wants to say why can, and a user who does not is not made to.
 */
export async function addToWatchlist(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const symbol = String(formData.get("symbol") ?? "");
  const result = await addSymbol(user.id, symbol);
  if (!result.ok) return { error: result.error };

  const type = String(formData.get("thesisType") ?? "none") as ThesisType;
  const noteInput = String(formData.get("note") ?? "");
  const note = noteInput.trim() ? noteInput : null;

  if (type !== "none" || note) {
    const low = Number(formData.get("low"));
    const high = Number(formData.get("high"));
    const level = Number(formData.get("level"));

    // A parameterised thesis without its parameter cannot be evaluated, so it is
    // recorded as a plain note rather than silently pretending to monitor.
    const missingParams =
      (type === "price_range" && !(Number.isFinite(low) && Number.isFinite(high) && high > low)) ||
      (type === "breakout" && !Number.isFinite(level));

    const resolvedType: ThesisType = missingParams ? "none" : type;
    const params =
      resolvedType === "price_range" ? { low, high, context: await creationContext(symbol.toUpperCase()) }
      : resolvedType === "breakout" ? { level, context: await creationContext(symbol.toUpperCase()) }
      : resolvedType === "none" ? {}
      : { context: await creationContext(symbol.toUpperCase()) };

    await createThesis({ watchlistItemId: result.watchlistItemId, type: resolvedType, params, note });
    if (missingParams) {
      revalidatePath("/watchlist");
      revalidatePath("/symbol/[symbol]", "page");
      return { error: "Saved without a monitored condition — that thesis type needs a price level." };
    }
  }

  revalidatePath("/watchlist");
  revalidatePath("/digest");
  // A company can now be added from its own detail page, which then has to stop
  // showing the "not watched" state it rendered a moment ago.
  revalidatePath("/symbol/[symbol]", "page");
  return {};
}

export async function removeFromWatchlist(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  await removeSymbol(user.id, String(formData.get("symbol") ?? ""));
  revalidatePath("/watchlist");
  revalidatePath("/symbol/[symbol]", "page");
}

/**
 * "Keep watching" — acknowledges a thesis.
 *
 * Resets state to WATCHING and restarts the minimum observation window, so the
 * same evidence cannot immediately re-contradict a thesis the user has just
 * looked at and decided to stand by.
 */
export async function acknowledge(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const thesisId = Number(formData.get("thesisId"));
  if (Number.isFinite(thesisId)) await acknowledgeThesis(user.id, thesisId);
  revalidatePath("/digest");
}

/** Commits a digest snapshot only after the browser has received and rendered it. */
export async function markDigestRead(cutoffIso: string): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  const requested = new Date(cutoffIso);
  if (!Number.isFinite(requested.getTime())) return;
  const committed = await lastCommittedBatchAt();
  if (!committed) return;

  // A caller can only acknowledge the snapshot it saw, never a future batch.
  const cutoff = requested <= committed ? requested : committed;
  await advanceDigestWatermark(user.id, cutoff);
}
