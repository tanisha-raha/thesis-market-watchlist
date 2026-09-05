import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getDigest } from "@/lib/digest";
import { getWatchlist } from "@/lib/watchlist";
import { Anomaly, Contradiction, Missed, Trigger } from "@/components/digest-cards";
import { formatIST } from "@/lib/time";
import { AppShell } from "@/components/app-shell";
import { DigestReadReceipt } from "@/components/digest-read-receipt";
import { DashboardCard, EmptyState, CompanyMark, Icon } from "@/components/ui";
import { AddStockButton } from "@/components/workspace-controls";

export const dynamic = "force-dynamic";
export default async function DigestPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const [d, rows] = await Promise.all([getDigest(user.id), getWatchlist(user.id)]);
  const counts = [
    { n: d.contradictions.length, label: "CONTRADICTED", detail: "Theses to revisit", tone: "text-contradiction" },
    { n: d.triggers.length, label: "TRIGGERED", detail: "Your conditions were met", tone: "text-trigger" },
    { n: d.missed.length, label: "MISSED", detail: "Happened and reversed", tone: "text-missed" },
    { n: d.unchanged.length, label: "UNCHANGED", detail: "In this digest window", tone: "text-muted" },
  ];
  const nothingAtAll = d.contradictions.length + d.triggers.length + d.missed.length + d.anomalies.length === 0;
  return <AppShell email={user.email} active="digest" rows={rows} demo={process.env.THESIS_DATA_MODE === "demo"}>
    <DigestReadReceipt cutoff={d.cutoff.toISOString()} />
    <div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL MARKET BRIEF</p><h1>While you were away</h1><p>{d.awayFrom ? `Since ${formatIST(d.awayFrom)} IST` : "Since you started watching"}{" · "}{d.marketClosedThroughout ? "No trading sessions in this window" : `${d.sessionsInWindow} trading ${d.sessionsInWindow === 1 ? "session" : "sessions"}`}</p></div><Link className="button-secondary" href="/">Home <Icon name="arrow" size={14} /></Link></div>
    <div className="summary-grid digest-counts">{counts.map((c) => <section key={c.label} className="metric-card"><span className="eyebrow">{c.label}</span><strong className={`num ${c.tone}`}>{c.n}</strong><span className="text-micro text-faint">{c.detail}</span></section>)}</div>
    <p className="text-micro text-faint mb-4">Snapshot through {formatIST(d.cutoff)} IST. Ordered by personal relevance.</p>
    {nothingAtAll && <DashboardCard><EmptyState title="No meaningful changes since your last check." description={rows.length ? "No new trigger, contradiction, or reversal is recorded in this digest window. Your watchlist and saved conditions remain in view." : "Add a company and an optional thesis. Your next meaningful change will have a place here."} icon="digest"><AddStockButton /></EmptyState></DashboardCard>}
    <div className="digest-timeline">
      {d.contradictions.map((c) => <Contradiction key={c.thesisId} card={c} />)}
      {d.triggers.map((c) => <Trigger key={c.thesisId} card={c} />)}
      {d.missed.map((c) => <Missed key={`${c.symbol}-${c.occurredAt.toISOString()}`} card={c} />)}
      {d.anomalies.map((c) => <Anomaly key={`${c.symbol}-${c.occurredAt.toISOString()}`} card={c} />)}
    </div>
    {d.unchanged.length > 0 && <DashboardCard title="Still on your radar" meta={<span className="count-chip">{d.unchanged.length} unchanged</span>} className="mt-4"><div className="unchanged-grid">{d.unchanged.map((u) => <Link key={u.symbol} href={`/symbol/${encodeURIComponent(u.symbol)}`}><CompanyMark symbol={u.symbol} /><div><strong>{u.symbol}</strong><small>{u.name}</small></div><Icon name="chevron" size={14} /></Link>)}</div></DashboardCard>}
    <div className="two-column mt-4"><DashboardCard title="What makes a change meaningful?"><div className="panel-body text-meta text-muted leading-relaxed">A condition met. A thesis contradicted. Or a move that happened and reversed before you returned. Each card preserves the evidence recorded at the time.</div></DashboardCard><DashboardCard title="Keep your reason in view"><div className="panel-body text-meta text-muted leading-relaxed">Your free-text notes are yours. Structured conditions connect market changes to why a company is on your watchlist.<Link href="/watchlist" className="panel-link !mx-0 mt-3">Review your watchlist <Icon name="arrow" size={14} /></Link></div></DashboardCard></div>
  </AppShell>;
}
