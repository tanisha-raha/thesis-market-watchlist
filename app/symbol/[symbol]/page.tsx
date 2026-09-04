import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, quotes, symbols, symbolStats, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { evidenceFrom } from "@/lib/digest";
import { Evidence, UserWords } from "@/components/evidence";
import { formatAge, formatIST } from "@/lib/time";
import { acknowledge } from "@/app/actions";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

const inr = (v: number | null) =>
  v == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;

const STATE_TONE: Record<string, string> = {
  CONTRADICTED: "text-contradiction",
  TRIGGERED: "text-trigger",
  STILL_VALID: "text-muted",
  WATCHING: "text-muted",
};

/**
 * Symbol detail: thesis versus reality.
 *
 * What you said, what happened, what changed around it, and the current status —
 * including, importantly, the case where nothing happened. A reader who clicks
 * through from "unchanged" is entitled to see that we looked and found nothing,
 * rather than being shown an empty page that could equally mean we never checked.
 */
export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { symbol: raw } = await params;
  const symbol = decodeURIComponent(raw);

  const [item] = await db
    .select({
      itemId: watchlistItems.id,
      name: symbols.name,
      thesisId: theses.id,
      thesisType: theses.type,
      thesisNote: theses.note,
      thesisState: theses.state,
      thesisCreatedAt: theses.createdAt,
      paramsAdjustedAt: theses.paramsAdjustedAt,
      thesisParams: theses.paramsJson,
      price: quotes.price,
      previousClose: quotes.previousClose,
      asOf: quotes.asOf,
      marketState: quotes.marketState,
    })
    .from(watchlistItems)
    .innerJoin(symbols, eq(symbols.symbol, watchlistItems.symbol))
    .leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
    .leftJoin(quotes, eq(quotes.symbol, watchlistItems.symbol))
    .where(and(eq(watchlistItems.userId, user.id), eq(watchlistItems.symbol, symbol)))
    .limit(1);

  if (!item) notFound();

  const price = item.price == null ? null : Number(item.price);
  const previousClose = item.previousClose == null ? null : Number(item.previousClose);
  const move = price != null && previousClose != null && previousClose !== 0
    ? ((price - previousClose) / previousClose) * 100
    : null;

  const storedParams = (item.thesisParams ?? {}) as Record<string, unknown>;
  const adjustments = (Array.isArray(storedParams.adjustments) ? storedParams.adjustments : []) as {
    reason: string; factor: number; affectedFrom: string; affectedTo: string;
    before: Record<string, number>; after: Record<string, number>;
  }[];

  const [stats] = await db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1);
  const events = await db.select().from(changeEvents)
    .where(eq(changeEvents.symbol, symbol)).orderBy(desc(changeEvents.occurredAt)).limit(12);
  const verdicts = item.thesisId
    ? await db.select().from(thesisEvents)
        .where(eq(thesisEvents.thesisId, item.thesisId)).orderBy(desc(thesisEvents.occurredAt)).limit(6)
    : [];

  return (
    <AppShell email={user.email} active="watchlist">
      <header className="mt-8 border-b border-line pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-title font-medium tracking-tight">{symbol}</h1>
            {item.name && <p className="mt-0.5 text-meta text-muted">{item.name}</p>}
          </div>
          <div className="text-right">
            <div className="num text-title">{inr(price)}</div>
            {move != null && (
              <div className={`num mt-0.5 text-meta ${move >= 0 ? "text-up" : "text-down"}`}>
                {move >= 0 ? "+" : ""}{move.toFixed(2)}% <span className="font-sans text-micro text-faint">vs prev close</span>
              </div>
            )}
            <div className="text-micro text-faint">
              {item.asOf ? (
                <span title={`Exchange time: ${formatIST(item.asOf)} IST`}>
                  {formatAge(item.asOf)}
                  {item.marketState && item.marketState !== "REGULAR" && " · market closed"}
                </span>
              ) : "awaiting first quote"}
            </div>
          </div>
        </div>
      </header>

      {/* --- thesis vs reality ------------------------------------------- */}
      <section className="mt-8">
        <h2 className="label">Your thesis</h2>
        {item.thesisType && item.thesisType !== "none" ? (
          <div className="mt-2">
            <UserWords
              prompt={{
                price_range: "Waiting for a dip", breakout: "Watching for a breakout",
                momentum_up: "Tracking momentum", momentum_down: "Tracking a decline",
                volatility_watch: "Watching for unusual moves",
                volume_expansion: "Watching for volume expansion",
              }[item.thesisType] ?? item.thesisType}
              note={item.thesisNote}
            />
            <p className="mt-2 text-meta">
              <span className={STATE_TONE[item.thesisState ?? "WATCHING"] ?? "text-muted"}>
                {(item.thesisState ?? "WATCHING").replace("_", " ").toLowerCase()}
              </span>
              {item.thesisCreatedAt && (
                <span className="text-faint">
                  {" · "}recorded {formatIST(item.thesisCreatedAt)}, evaluated from then onward
                </span>
              )}
            </p>
            {/*
              Never a silent rewrite. The user typed a number; a corporate action
              changed what that number means, so we show both and say why.
            */}
            {item.paramsAdjustedAt && adjustments.length > 0 && (
              <div className="mt-3 border-l-2 border-missed bg-missed-soft/40 py-3 pl-3 pr-3">
                <div className="label text-missed">Adjusted for a corporate action</div>
                {adjustments.map((a, i) => (
                  <div key={i} className="mt-2">
                    <p className="text-meta text-muted">
                      A {a.reason} between {a.affectedFrom} and {a.affectedTo} restated this
                      symbol&rsquo;s price history by{" "}
                      <span className="num">{a.factor}×</span>. We adjusted the levels you
                      wrote so they still mean what you meant.
                    </p>
                    <dl className="mt-2 grid grid-cols-[auto_auto_auto] items-baseline gap-x-3 gap-y-1">
                      {Object.keys(a.before).map((k) => (
                        <div key={k} className="contents">
                          <dt className="text-meta text-muted capitalize">{k}</dt>
                          <dd className="num text-meta text-faint line-through">{inr(a.before[k])}</dd>
                          <dd className="num text-body text-ink">{inr(a.after[k])}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}
            {item.thesisId && (
              <form action={acknowledge} className="mt-3">
                <input type="hidden" name="thesisId" value={item.thesisId} />
                <button className="rounded-sm border border-line bg-surface px-3 py-1.5 text-meta text-muted transition-colors hover:border-line-strong hover:text-ink">
                  Keep watching
                </button>
              </form>
            )}
          </div>
        ) : (
          <p className="mt-2 text-body text-muted">
            No thesis recorded. You&rsquo;ll see general anomalies for this symbol.
          </p>
        )}
      </section>

      {verdicts.length > 0 && (
        <section className="mt-8">
          <h2 className="label">Verdict history</h2>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {verdicts.map((v) => (
              <li key={v.id} className="flex items-baseline justify-between gap-4 py-2">
                <span className={`text-body ${v.kind === "contradicted" ? "text-contradiction" : "text-trigger"}`}>
                  {v.kind}
                </span>
                <span className="text-meta text-faint">
                  {(v.conditionsMetJson as string[]).join(", ")}
                </span>
                <time className="num text-micro text-faint">{formatIST(v.occurredAt)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- what changed around it --------------------------------------- */}
      <section className="mt-8">
        <h2 className="label">What changed around it</h2>
        {events.length === 0 ? (
          <p className="mt-2 rounded-sm border border-dashed border-line-strong px-4 py-6 text-body text-muted">
            Nothing detected. We hold {stats?.sessionsUsed ?? 0} sessions of history for this symbol
            and evaluate it on every ingestion run — this is nothing having happened, not nothing
            having been checked.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {events.map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-body">{e.signalType.replace(/_/g, " ")}</span>
                  <span className="text-micro text-faint">
                    {formatIST(e.occurredAt)}
                    {e.resolvedAt && <> → {formatIST(e.resolvedAt)} · reversed</>}
                  </span>
                </div>
                <div className="mt-2">
                  <Evidence entries={evidenceFrom(e.explainJson as Record<string, unknown>).slice(0, 5)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {stats && (
        <section className="mt-8">
          <h2 className="label">Reference levels</h2>
          <div className="mt-2">
            <Evidence
              entries={[
                { label: "52-week high", value: inr(stats.high52w == null ? null : Number(stats.high52w)), basis: "adjusted closes" },
                { label: "52-week low", value: inr(stats.low52w == null ? null : Number(stats.low52w)), basis: "adjusted closes" },
                { label: "20-day average", value: inr(stats.ma20 == null ? null : Number(stats.ma20)) },
                { label: "Realized volatility", value: stats.realizedVol20 == null ? "—" : `${(Number(stats.realizedVol20) * 100).toFixed(2)}%`, basis: "daily, 20-day" },
                { label: "Beta", value: stats.beta60 == null ? "—" : Number(stats.beta60).toFixed(2), basis: "60-day, vs ^NSEI" },
                { label: "Sessions held", value: String(stats.sessionsUsed), basis: "traded sessions only" },
              ]}
            />
          </div>
        </section>
      )}
    </AppShell>
  );
}
