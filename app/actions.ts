"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authenticate, createSession, destroySession, getSessionUser, registerUser } from "@/lib/auth";
import { addSymbol, removeSymbol } from "@/lib/watchlist";

export type FormState = { error?: string } | undefined;

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const result = await authenticate(email, password);
  if (!result.ok) return { error: result.error };
  await createSession(result.userId);
  redirect("/watchlist");
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const result = await registerUser(email, password);
  if (!result.ok) return { error: result.error };
  await createSession(result.userId);
  redirect("/watchlist");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}

export async function addToWatchlist(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const result = await addSymbol(user.id, String(formData.get("symbol") ?? ""));
  if (!result.ok) return { error: result.error };
  revalidatePath("/watchlist");
  return {};
}

export async function removeFromWatchlist(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  await removeSymbol(user.id, String(formData.get("symbol") ?? ""));
  revalidatePath("/watchlist");
}
