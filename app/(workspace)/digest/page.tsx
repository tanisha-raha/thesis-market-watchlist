import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getDigest } from "@/lib/digest";
import { getWatchlist } from "@/lib/watchlist";
import { getThesisHealth } from "@/lib/notifications";
import { ThesisHealthBadge } from "@/components/thesis-health-badge";
import { Anomaly, Contradiction, Missed, Trigger } from "@/components/digest-cards";
import { formatIST } from "@/lib/time";
import { marketLine } from "@/lib/securities";
import { AppShell } from "@/components/app-shell";
import { DigestReadReceipt } from "@/components/digest-read-receipt";
import { DashboardCard, EmptyState, CompanyMark, Icon } from "@/components/ui";
import { traceRoute, traced } from "@/lib/trace";

export const dynamic = "force-dynamic";
export default async function DigestPage() {
  const done = traceRoute("digest");
  const user = await traced("digest:session", () => getSessionUser());
  if (!user) redirect("/login");
  const [d, rows, health] = await Promise.all([
    traced("digest:digest", () => getDigest(user.id)),
    traced("digest:watchlist", () => getWatchlist(user.id)),
    traced("digest:health", () => getThesisHealth(user.id)),
  ]);
  // Only the theses with something to say. A digest of "everything is fine" is
  // the noise this product exists to avoid.
  const attention = [...health.values()].filter((view) => view.health !== "STRONG");
  done();
  const counts = [
    { n: d.contradictions.length, label: "CONTRADICTED", detail: "Theses to revisit", tone: "text-contradiction" },
    { n: d.triggers.length, label: "TRIGGERED", detail: "Your conditions were met", tone: "text-trigger" },
    { n: d.missed.length, label: "MISSED", detail: "Happened and reversed", tone: "text-missed" },
    { n: d.unchanged.length, label: "UNCHANGED", detail: "In this digest window", tone: "text-muted" },
  ];
  const nothingAtAll = d.contradictions.length + d.triggers.length + d.missed.length + d.anomalies.length === 0;
  return <AppShell email={user.email} displayName={user.displayName} active="digest" rows={rows} demo={process.env.THESIS_DATA_MODE === "demo"}>
    <DigestReadReceipt cutoff={d.cutoff.toISOString()} />
    <div className="page-heading"><div><p className="eyebrow">YOUR SINCE-LAST-VISIT DIGEST</p><h1>While you were away</h1><p>{d.awayFrom ? `Since ${formatIST(d.awayFrom)} IST` : "Since you started watching"}{" · "}{d.marketClosedThroughout ? "No trading sessions in this window" : `${d.sessionsInWindow} trading ${d.sessionsInWindow === 1 ? "session" : "sessions"}`}</p></div></div>
    <div className="summary-grid digest-counts">{counts.map((c) => <section key={c.label} className="metric-card"><span className="eyebrow">{c.label}</span><strong className={`num ${c.tone}`}>{c.n}</strong><span className="text-micro text-faint">{c.detail}</span></section>)}</div>
    <p className="text-micro text-faint mb-4">Snapshot through {formatIST(d.cutoff)} IST — the completion time of the last committed ingestion batch. Ordered by personal relevance; each event is shown in its own market’s currency and exchange time.</p>
    {nothingAtAll && <DashboardCard><EmptyState title="No meaningful changes since your last check." description={rows.length ? "No new trigger, contradiction, or reversal is recorded in this digest window." : "Add a company and an optional thesis. Your next meaningful change will have a place here."} icon="digest"><Link href="/watchlist" className="button-secondary mt-2">View watchlist</Link></EmptyState></DashboardCard>}
    {attention.length > 0 && <DashboardCard title="Thesis Health" action={<span className="eyebrow">YOUR CONDITIONS</span>} className="mb-4">
      <div className="digest-health">{attention.map((view) => <Link key={view.symbol} href={`/symbol/${encodeURIComponent(view.symbol)}`}>
        <span className="digest-health-head"><strong className="num">{view.symbol}</strong><ThesisHealthBadge health={view.health} compact /></span>
        <span>{view.reason}</span>
        <span className="digest-health-link">Review thesis <Icon name="arrow" size={13} /></span>
      </Link>)}</div>
      <p className="panel-caption">Thesis Health evaluates the condition you stated, not the company or its expected return.</p>
    </DashboardCard>}
    <div className="digest-timeline">
      {d.contradictions.map((c) => <Contradiction key={c.thesisId} card={c} />)}
      {d.triggers.map((c) => <Trigger key={c.thesisId} card={c} />)}
      {d.missed.map((c) => <Missed key={`${c.symbol}-${c.occurredAt.toISOString()}`} card={c} />)}
      {d.anomalies.map((c) => <Anomaly key={`${c.symbol}-${c.occurredAt.toISOString()}`} card={c} />)}
    </div>
    {d.unchanged.length > 0 && <DashboardCard title="Still on your radar" meta={<span className="count-chip">{d.unchanged.length} unchanged</span>} className="mt-4"><div className="unchanged-grid">{d.unchanged.map((u) => <Link key={u.symbol} href={`/symbol/${encodeURIComponent(u.symbol)}`}><CompanyMark symbol={u.symbol} /><div><strong>{u.symbol}</strong><small>{u.name}{marketLine(u.security) ? ` · ${marketLine(u.security)}` : ""}</small></div><Icon name="chevron" size={14} /></Link>)}</div></DashboardCard>}
  </AppShell>;
}
