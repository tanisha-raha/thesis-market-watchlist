import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { AuthForm } from "./auth-form";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/digest");

  return (
    <div className="mx-auto grid min-h-[calc(100vh-13rem)] max-w-7xl items-center gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-20">
      <section className="relative overflow-hidden py-8 lg:py-16">
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-70 [background-image:linear-gradient(rgba(113,134,151,.13)_1px,transparent_1px),linear-gradient(90deg,rgba(113,134,151,.13)_1px,transparent_1px)] [background-size:42px_42px]" />
        <p className="text-section font-semibold uppercase tracking-[0.22em] text-ink">Thesis</p>
        <h1 className="mt-6 max-w-xl text-4xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-5xl">
          A watchlist that remembers why you&rsquo;re watching.
        </h1>
        <p className="mt-6 max-w-lg text-emphasis leading-7 text-muted">
          Markets move constantly. THESIS remembers the reason you were watching and tells you what actually changed.
        </p>

        <div className="relative mt-10 max-w-xl overflow-hidden border border-line bg-surface/45 p-5 shadow-[0_0_56px_rgba(55,211,173,.08)] backdrop-blur-sm">
          <div className="absolute inset-x-0 top-0 h-px bg-accent/70" />
          <div className="flex h-32 items-end gap-2" aria-hidden="true">
            {[28, 45, 37, 62, 48, 76, 58, 91, 67, 100].map((height, index) => (
              <span key={index} className="flex-1 bg-gradient-to-t from-accent/20 to-accent/80" style={{ height: `${height}%` }} />
            ))}
          </div>
          <div className="mt-4 grid gap-3 border-t border-line pt-4 text-meta text-muted sm:grid-cols-3">
            <p><span className="mr-2 text-accent">•</span>Meaningful changes</p>
            <p><span className="mr-2 text-accent">•</span>Personal thesis tracking</p>
            <p><span className="mr-2 text-accent">•</span>Evidence, not noise</p>
          </div>
        </div>
      </section>

      <section className="border border-line-strong bg-surface/75 p-5 shadow-[0_0_70px_rgba(55,211,173,.10)] backdrop-blur-md sm:p-7">
        <p className="label text-accent">Your workspace</p>
        <h2 className="mt-2 text-section font-medium tracking-tight">Keep the reason in view.</h2>
        <div className="mt-7">
          <AuthForm />
        </div>
      </section>
    </div>
  );
}
