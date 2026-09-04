"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type FormState } from "@/app/actions";

const field =
  "mt-1 w-full border border-line bg-paper/60 px-3 py-2.5 text-body text-ink placeholder:text-faint " +
  "outline-none transition-colors focus:border-accent focus:shadow-[0_0_0_3px_rgba(55,211,173,.12)]";

export function AuthForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const action = mode === "in" ? signIn : signUp;
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, undefined);

  return (
    <div>
      {/* Segmented control: the selected tab carries the ink fill, the other is quiet. */}
      <div className="mb-6 grid grid-cols-2 border-b border-line text-meta">
        {([["in", "Sign in"], ["up", "Create account"]] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={
              "border-b-2 px-3 py-2 text-left font-medium uppercase tracking-[0.08em] transition-colors " +
              (mode === m
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      <form action={formAction} className="space-y-4">
        <label className="block">
          <span className="label">Email</span>
          <input name="email" type="email" required autoComplete="email" className={field} />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input
            name="password" type="password" required minLength={8}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            className={field}
          />
        </label>

        {state?.error && (
          <p className="text-meta text-down" role="alert">{state.error}</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full bg-accent py-3 text-body font-semibold text-paper
                     transition-all hover:bg-[#61e4c4] active:translate-y-px disabled:opacity-40"
        >
          {pending ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
