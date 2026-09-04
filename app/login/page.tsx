import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AuthForm } from "./auth-form";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/watchlist");

  return (
    <div className="mx-auto max-w-sm pt-16">
      <h1 className="text-title font-medium tracking-tight">Thesis</h1>
      <p className="mt-1 text-body text-muted">
        A watchlist that remembers why you&rsquo;re watching.
      </p>
      <div className="mt-10">
        <AuthForm />
      </div>
    </div>
  );
}
