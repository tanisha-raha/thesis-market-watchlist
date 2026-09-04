import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AuthForm } from "./auth-form";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/digest");

  return (
    <div className="mx-auto max-w-sm pt-12">
      <p className="label text-accent">Thesis</p>
      <h1 className="mt-2 text-title font-medium tracking-tight">A watchlist that remembers why you&rsquo;re watching.</h1>
      <p className="mt-3 text-body text-muted">Track what changed, what mattered, and whether the reason you were watching still holds.</p>
      <div className="mt-10">
        <AuthForm />
      </div>
    </div>
  );
}
