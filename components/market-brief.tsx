import Link from "next/link";
import { homeGreeting } from "@/lib/user-profile";
import { HomeGreeting } from "@/components/home-greeting";
import { formatExchangeTime } from "@/lib/time";
import { DashboardCard, EmptyState, FreshnessBadge, Icon, PriceChange } from "@/components/ui";
import { PriceChart } from "@/components/price-chart";
import { marketStatusLine, type MarketStatus } from "@/lib/market-brief";
import type { MarketIndexCard, MarketOverview } from "@/lib/market-brief-server";
import type { NewsItem } from "@/lib/market-brief";

/**
 * Home is the market brief. Not a second watchlist, not a second digest.
 *
 * Each screen answers one question: Home says what is happening across the
 * markets, Watchlist says what you are watching and why, Digest says what
 * happened while you were away. Duplicating a table across two of them is how a
 * product stops having a shape.
 */
export function HomeHero({ name }: { name: string | null }) {
  return <section className="home-hero">
    <div className="home-hero-copy">
      <span className="eyebrow">YOUR MARKET BRIEF</span>
      <h1><HomeGreeting name={name} initial={homeGreeting(name)} /></h1>
      <p>Here’s what’s happening across the markets today.</p>
    </div>
    <p className="home-hero-statement">Markets move.<br />Keep your reason in view.<span aria-hidden="true" /></p>
  </section>;
}

function IndexCard({ card }: { card: MarketIndexCard }) {
  const level = (n: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return <section className="panel index-card">
    <div className="index-identity"><span className="eyebrow">{card.name}</span><small className="num">{card.symbol}</small></div>
    {card.quote ? <>
      <strong className="index-level num">{level(card.quote.price)}</strong>
      <div className="index-movement">
        <span className={card.quote.change == null ? "text-faint num" : card.quote.change >= 0 ? "text-up num" : "text-down num"}>
          {card.quote.change == null ? "—" : `${card.quote.change >= 0 ? "+" : ""}${level(card.quote.change)}`}
        </span>
        <PriceChange value={card.quote.percent} />
      </div>
    </> : <>
      <strong className="index-level index-level-empty">Unavailable</strong>
      <div className="index-movement"><span className="text-faint">No valid index quote right now</span></div>
    </>}
    {/* A chart region that is always the same height, so six cards line up —
        and says why it is empty rather than leaving a blank rectangle. */}
    <div className="index-spark">
      {card.points.length >= 2
        ? <PriceChart points={card.points} compact />
        : <p className="index-no-history">History unavailable</p>}
    </div>
    <div className="index-foot">
      <FreshnessBadge asOf={card.quote?.asOf ?? null} marketState={card.quote?.marketState ?? null} health={card.degraded ? "degraded" : "ok"} timeZone={card.timeZone} />
      <small>{card.quote ? formatExchangeTime(card.quote.asOf, card.timeZone) : "awaiting data"}</small>
    </div>
  </section>;
}

function StatusChip({ status }: { status: MarketStatus }) {
  // No provider state means no claim. Freshness on each card still tells the
  // truth about the data; inventing "closed" would not.
  if (!status) return <span className="status-badge neutral">STATE UNAVAILABLE</span>;
  return <span className={`status-badge ${status === "OPEN" ? "positive" : "neutral"}`}>{status}</span>;
}

export function MarketPulse({ overview }: { overview: MarketOverview }) {
  const line = marketStatusLine(overview.regions.map((r) => ({ region: r.region, status: r.status })));
  return <section className="market-pulse" aria-label="Global market pulse">
    <header className="section-heading">
      <div>
        <span className="eyebrow">GLOBAL MARKET PULSE</span>
        <h2>Two markets, each on its own clock</h2>
      </div>
      <span className="market-status-line">{line ?? "Session state unavailable · showing data freshness"}</span>
    </header>
    {overview.regions.map((region) => <div key={region.region} className="pulse-region">
      <div className="pulse-region-heading"><h3>{region.label}</h3><StatusChip status={region.status} /></div>
      <div className="market-indices">{region.indices.map((card) => <IndexCard key={card.symbol} card={card} />)}</div>
    </div>)}
  </section>;
}

/**
 * The one personal thing on Home: three counts and a way in.
 *
 * Not a watchlist, not a digest — a bridge from the market view to the user's
 * own reasons, sized so it cannot grow into either of them.
 */
export function PersonalSummary({ watched, conditions, changes }: { watched: number; conditions: number; changes: number }) {
  const metrics = [
    { value: watched, label: watched === 1 ? "Watched stock" : "Watched stocks" },
    { value: conditions, label: conditions === 1 ? "Active condition" : "Active conditions" },
    { value: changes, label: changes === 1 ? "New change" : "New changes" },
  ];
  return <section className="panel thesis-strip">
    <div className="thesis-strip-head">
      <span className="eyebrow">YOUR THESIS</span>
      <Link href="/digest" className="thesis-strip-link">View Digest <Icon name="arrow" size={15} /></Link>
    </div>
    <div className="thesis-strip-metrics">
      {metrics.map((metric) => <div key={metric.label}>
        <strong className="num">{metric.value}</strong>
        <span>{metric.label}</span>
      </div>)}
    </div>
    <p className={`thesis-strip-status ${changes > 0 ? "needs-attention" : ""}`}>
      {changes === 0
        ? <>Nothing needs your attention right now.</>
        : <>{changes} {changes === 1 ? "change is" : "changes are"} waiting in your digest. <Link href="/digest">See what changed</Link></>}
    </p>
  </section>;
}

/**
 * Market context, and nothing more.
 *
 * News never reaches the detection engine, a thesis verdict, stored evidence or
 * a replay, and THESIS never claims a headline explains a price move. It is here
 * because reading the market is part of the morning; it is not evidence.
 */
export function MarketBriefing({ news }: { news: NewsItem[] }) {
  return <DashboardCard title="Market Briefing" action={<span className="eyebrow">INDIA-FOCUSED CONTEXT</span>} className="market-news">
    {news.length
      ? <div className="news-list">{news.map((item) => <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer" className="news-item">
          <span className="eyebrow">{item.category}</span>
          <h3>{item.title}</h3>
          <p>{item.source} · <time dateTime={item.publishedAt}>{formatExchangeTime(new Date(item.publishedAt), "Asia/Kolkata")}</time></p>
          <Icon name="arrow" size={16} />
        </a>)}</div>
      : <EmptyState title="Market briefing is unavailable right now." description="Current headlines could not be retrieved. Your watchlist, detection and digest are unaffected." />}
    <p className="panel-caption">Headlines from The Economic Times — Indian market coverage, not comprehensive global news. Context only: never an explanation of an individual price move, and never an input to THESIS decisions.</p>
  </DashboardCard>;
}
