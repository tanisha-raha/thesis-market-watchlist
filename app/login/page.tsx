import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { BrandMark, Icon } from "@/components/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { AuthForm } from "./auth-form";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/");
  return <div className="auth-page">
    <header className="auth-top"><a href="/" className="brand"><BrandMark /><div><strong>THESIS</strong><small>Track. Think. Invest Smarter.</small></div></a><ThemeToggle /></header>
    <div className="auth-grid">
      <section className="auth-story"><p className="eyebrow">YOUR REASON. IN VIEW.</p><h1>A watchlist that remembers why you’re watching.</h1><p>Track meaningful market changes against the reason you started watching.</p>
        <div className="auth-landscape" role="img" aria-label="Mountain peaks at dawn"><span>Markets move.<br />Keep your perspective.</span></div>
        <div className="auth-principles"><span><Icon name="activity" size={16} />Meaningful changes</span><span><Icon name="shield" size={16} />Evidence, not predictions</span></div>
      </section>
      <AuthForm />
    </div>
  </div>;
}
