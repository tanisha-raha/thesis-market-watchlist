"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type FormState } from "@/app/actions";

export function AuthForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const action = mode === "in" ? signIn : signUp;
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, undefined);

  return (
    <div>
      <div className="mb-5 flex gap-1 text-sm">
        {(["in", "up"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded px-3 py-1 ${
              mode === m ? "bg-[--color-ink] text-white" : "text-[--color-muted] hover:text-[--color-ink]"
            }`}
          >
            {m === "in" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form action={formAction} className="space-y-3">
        <label className="block">
          <span className="text-xs text-[--color-muted]">Email</span>
          <input
            name="email" type="email" required autoComplete="email"
            className="mt-1 w-full rounded border border-[--color-line] bg-white px-3 py-2 text-sm outline-none focus:border-[--color-ink]"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[--color-muted]">Password</span>
          <input
            name="password" type="password" required minLength={8}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            className="mt-1 w-full rounded border border-[--color-line] bg-white px-3 py-2 text-sm outline-none focus:border-[--color-ink]"
          />
        </label>

        {state?.error && <p className="text-sm text-[--color-down]">{state.error}</p>}

        <button
          type="submit" disabled={pending}
          className="w-full rounded bg-[--color-ink] py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
