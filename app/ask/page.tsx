import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { AppShell } from "@/components/app-shell";
import { AskThesisChat } from "@/components/ask-thesis-chat";
import { Icon } from "@/components/ui";

export const dynamic = "force-dynamic";
export default async function AskPage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const rows = await getWatchlist(user.id);
  const requested = (await searchParams).symbol;
  const currentSymbol = typeof requested === "string" ? rows.find((row) => row.symbol === requested.toUpperCase())?.symbol : undefined;
  const demo = process.env.THESIS_DATA_MODE === "demo";
  return <AppShell email={user.email} displayName={user.displayName} active="ask" rows={rows} demo={demo} currentSymbol={currentSymbol}>
    <div className="ask-page"><div className="ask-context"><span className="eyebrow">{currentSymbol ? `CONTEXT · ${currentSymbol}` : "YOUR WATCHLIST · YOUR EVIDENCE"}</span>{currentSymbol && <Link href={`/symbol/${encodeURIComponent(currentSymbol)}`}><Icon name="arrow" size={14} /> Back to stock</Link>}</div>
      {requested && !currentSymbol && <p className="context-notice">That symbol is not on your watchlist. Ask THESIS will use only your watched companies.</p>}
      <AskThesisChat key={currentSymbol ?? "watchlist"} userId={user.id} currentSymbol={currentSymbol} demo={demo} />
    </div>
  </AppShell>;
}
