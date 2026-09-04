"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type FormState } from "@/app/actions";

const field =
  "mt-1 w-full rounded-sm border border-line bg-surface px-3 py-2 text-body " +
  "outline-none transition-colors focus:border-accent";

export function AuthForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const action = mode === "in" ? signIn : signUp;
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, undefined);

  return (
    <div>
      {/* Segmented control: the selected tab carries the ink fill, the other is quiet. */}
      <div className="mb-6 inline-flex rounded-sm border border-line bg-surface p-0.5 text-meta">
        {([["in", "Sign in"], ["up", "Create account"]] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={
              "rounded-[2px] px-3 py-1.5 transition-colors " +
              (mode === m
                ? "bg-ink text-white"
                : "text-muted hover:text-ink")
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
          className="w-full rounded-sm bg-ink py-2.5 text-body font-medium text-white
                     transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
