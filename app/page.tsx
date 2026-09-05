import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { getDigest } from "@/lib/digest";
import { getPresentationData } from "@/lib/presentation";
import { getMarketNews, getMarketOverview } from "@/lib/market-brief-server";
import { AppShell } from "@/components/app-shell";
import { HomeHero, MarketPulse, MarketBriefing, PersonalSummary } from "@/components/market-brief";

export const dynamic = "force-dynamic";

/**
 * Home answers one question: what is happening across the markets right now.
 *
 * The watchlist table, the thesis evidence and the digest cards each live on
 * their own screen. What is personal here is deliberately three numbers and a
 * link — enough to bridge the market view to the user's own reasons, not enough
 * to become a second copy of another page.
 */
export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const [rows, digest, presentation, overview, news] = await Promise.all([
    getWatchlist(user.id), getDigest(user.id), getPresentationData(user.id), getMarketOverview(), getMarketNews(),
  ]);
  const changes = digest.triggers.length + digest.contradictions.length + digest.missed.length + digest.anomalies.length;
  return <AppShell email={user.email} displayName={user.displayName} active="home" rows={rows} demo={presentation.demo}>
    <HomeHero name={user.displayName} />
    <MarketPulse overview={overview} />
    <PersonalSummary watched={rows.length} conditions={presentation.theses.filter((t) => t.type !== "none").length} changes={changes} />
    <MarketBriefing news={news} />
  </AppShell>;
}
