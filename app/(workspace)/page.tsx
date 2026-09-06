import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { getPresentationData } from "@/lib/presentation";
import { AppShell } from "@/components/app-shell";
import {
  HomeHero, MarketBriefingSection, MarketBriefingSkeleton, MarketPulseSection,
  MarketPulseSkeleton, PersonalSummarySection, PersonalSummarySkeleton,
} from "@/components/market-brief";
import { traceRoute, traced } from "@/lib/trace";

export const dynamic = "force-dynamic";

/**
 * Home answers one question: what is happening across the markets right now.
 *
 * NAVIGATION NEVER WAITS FOR THE PROVIDER. Only stored state is awaited here —
 * the session and the watchlist the shell needs — so the page starts streaming
 * after two database reads. The market pulse, the personal strip and the briefing
 * each stream in behind their own Suspense boundary, which is where the provider
 * call and the digest computation now live.
 */
export default async function Home() {
  const done = traceRoute("home");
  const user = await traced("home:session", () => getSessionUser());
  if (!user) redirect("/login");
  const [rows, presentation] = await Promise.all([
    traced("home:watchlist", () => getWatchlist(user.id)),
    traced("home:presentation", () => getPresentationData(user.id)),
  ]);
  done();
  return <AppShell email={user.email} displayName={user.displayName} active="home" rows={rows} demo={presentation.demo}>
    <HomeHero name={user.displayName} />
    <Suspense fallback={<MarketPulseSkeleton />}><MarketPulseSection /></Suspense>
    <Suspense fallback={<PersonalSummarySkeleton />}><PersonalSummarySection userId={user.id} /></Suspense>
    <Suspense fallback={<MarketBriefingSkeleton />}><MarketBriefingSection /></Suspense>
  </AppShell>;
}
