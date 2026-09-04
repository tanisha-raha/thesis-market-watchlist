import Link from "next/link";
import { signOut } from "@/app/actions";
import { AskThesisDrawer } from "@/components/ask-thesis-drawer";

type AppShellProps = {
  email: string;
  active: "digest" | "watchlist";
  currentSymbol?: string;
  children: React.ReactNode;
};

/**
 * The signed-in frame is intentionally modest: one place to orient yourself,
 * move between the two working surfaces, or leave the session.  Pages own their
 * content; this component only prevents that orientation from drifting.
 */
export function AppShell({ email, active, currentSymbol, children }: AppShellProps) {
  const navClass = (item: "digest" | "watchlist") =>
    `transition-colors ${active === item ? "text-ink" : "text-muted hover:text-ink"}`;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-line py-4 sm:py-5">
        <Link href="/digest" className="text-section font-semibold uppercase tracking-[0.16em]">Thesis</Link>
        <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 text-meta">
          <nav aria-label="Main navigation" className="flex items-center gap-4">
            <Link href="/digest" aria-current={active === "digest" ? "page" : undefined} className={navClass("digest")}>
              Digest
            </Link>
            <Link href="/watchlist" aria-current={active === "watchlist" ? "page" : undefined} className={navClass("watchlist")}>
              Watchlist
            </Link>
            <Link href="/watchlist#add-stock" className="text-accent transition-colors hover:text-ink">
              + Add stock
            </Link>
          </nav>
          <span className="hidden max-w-40 truncate text-faint sm:inline" title={email}>{email}</span>
          <AskThesisDrawer currentSymbol={currentSymbol} />
          <form action={signOut}>
            <button className="text-muted transition-colors hover:text-ink">Sign out</button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
