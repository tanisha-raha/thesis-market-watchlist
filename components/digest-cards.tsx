import Link from "next/link";
import { formatExchangeTime, formatInZone } from "@/lib/time";
import { formatMoney, marketLine, sessionWindow, type Security } from "@/lib/securities";
import { Evidence, UserWords } from "@/components/evidence";
import type { AnomalyCard, ContradictionCard, MissedCard, TriggerCard } from "@/lib/digest";

/**
 * Every card renders in its security's own units: its currency, its exchange's
 * clock, its session. A digest holding both an NSE and a NASDAQ event has to be
 * right about both.
 */
const money = (v: number, security: Security) => formatMoney(v, security.currency);
const at = (value: Date, security: Security) => formatExchangeTime(value, security.timeZone);

function SymbolLink({ symbol, name, security }: { symbol: string; name: string | null; security?: Security }) {
  const market = security ? marketLine(security) : "";
  return (
    <Link href={`/symbol/${encodeURIComponent(symbol)}`} className="group inline-flex items-baseline gap-2">
      <span className="font-medium underline-offset-2 group-hover:underline">{symbol}</span>
      {name && <span className="text-meta text-faint">{name}</span>}
      {market && <span className="text-micro text-faint">{market}</span>}
    </Link>
  );
}

/* --------------------------------------------------------- contradiction */

/**
 * Structurally an ARGUMENT: claim, then the conditions tested, then conclusion.
 *
 * The unmet condition is shown deliberately. It is the strongest defence against
 * the charge this product is most exposed to — that it is an oracle with numbers
 * painted on. A row that did not fire proves the rule was evaluated rather than
 * reverse-engineered from a conclusion already reached. Where that risks reading
 * busy, the answer is weight and spacing, never hiding the row.
 */
export function Contradiction({ card }: { card: ContradictionCard }) {
  return (
    <article className="border-l-2 border-contradiction bg-contradiction-soft/40 py-4 pl-4 pr-4">
      <header className="flex items-baseline justify-between gap-4">
        <span className="label text-contradiction">Contradicted</span>
        <time className="text-micro text-faint">{at(card.occurredAt, card.security)}</time>
      </header>

      <div className="mt-2">
        <SymbolLink symbol={card.symbol} name={card.name} security={card.security} />
      </div>

      <div className="mt-4">
        <div className="label mb-1.5">You said</div>
        <UserWords prompt={card.prompt} note={card.note} />
      </div>

      <div className="mt-4">
        <div className="text-meta text-muted">
          {card.conditions.length} conditions tested. {card.conditionsRequired} must fail.
        </div>
        <ul className="mt-2 space-y-1.5">
          {card.conditions.map((c) => (
            <li
              key={c.name}
              className={`flex items-baseline gap-3 ${c.met ? "text-ink" : "text-faint"}`}
            >
              <span
                aria-hidden
                className={`num w-3 shrink-0 text-center ${c.met ? "text-contradiction" : "text-faint"}`}
              >
                {c.met ? "✕" : "○"}
              </span>
              <span className="sr-only">{c.met ? "Condition failed:" : "Condition held:"}</span>
              <span className={`flex-1 text-body ${c.met ? "font-medium" : "font-normal"}`}>
                {c.label}
              </span>
              <span className="num text-meta">{c.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {card.sustainedSessions != null && (
        <p className="mt-3 text-micro text-faint">
          Sustained {card.sustainedSessions} consecutive sessions before we reported it.
        </p>
      )}

      {card.evidence.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-meta text-muted hover:text-ink">Evidence</summary>
          <div className="mt-3 border-t border-line pt-3">
            <Evidence entries={card.evidence} />
          </div>
        </details>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- trigger */

/** Structurally a MOMENT: the condition restated, and when it was met. Compact. */
export function Trigger({ card }: { card: TriggerCard }) {
  return (
    <article className="border-l-2 border-trigger bg-trigger-soft/40 py-4 pl-4 pr-4">
      <header className="flex items-baseline justify-between gap-4">
        <span className="label text-trigger">Condition met</span>
        <time className="text-micro text-faint">{at(card.occurredAt, card.security)}</time>
      </header>

      <div className="mt-2">
        <SymbolLink symbol={card.symbol} name={card.name} security={card.security} />
      </div>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-meta text-muted">Your condition</dt>
        <dd className="text-body">{card.conditionText}</dd>
      </dl>

      {card.note && (
        <p className="mt-2 text-meta text-muted whitespace-pre-wrap">&ldquo;{card.note}&rdquo;</p>
      )}

      {card.evidence.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-meta text-muted hover:text-ink">Evidence</summary>
          <div className="mt-3 border-t border-line pt-3">
            <Evidence entries={card.evidence} />
          </div>
        </details>
      )}
    </article>
  );
}

/* ----------------------------------------------------------- missed event */

/**
 * Structurally TIME. The only card in the product with a time axis, because it
 * is the only kind of news whose meaning is a duration rather than an instant.
 *
 * Every other card answers "what happened"; this one answers "what happened
 * while you were not looking, and then undid itself". The bar is what makes
 * that land — a timestamp pair would not.
 */
export function Missed({ card }: { card: MissedCard }) {
  // The axis is the TRADING SESSION, not the away-window.
  //
  // Scaling to the away-window was the obvious choice and the wrong one: against
  // two months, a 185-minute event is a 0.1% sliver that communicates "tiny"
  // without communicating "when". The session is the frame in which a duration
  // is legible — 185 of 375 minutes reads immediately as most of a day. How long
  // the user was away is a separate fact, and is stated as one.
  // The frame is THAT security's session on ITS own exchange.
  const window = sessionWindow(card.security, card.occurredAt);
  const open = window.open.getTime();
  const session = window.close.getTime() - open;

  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const left = clamp(((card.occurredAt.getTime() - open) / session) * 100);
  const right = clamp(((card.resolvedAt.getTime() - open) / session) * 100);
  const width = Math.max(1.5, right - left);

  return (
    <article className="border-l-2 border-missed bg-missed-soft/40 py-4 pl-4 pr-4">
      <header className="flex items-baseline justify-between gap-4">
        <span className="label text-missed">Happened and reversed</span>
        <span className="num text-micro text-faint">{card.durationMinutes} min</span>
      </header>

      <div className="mt-2 flex items-baseline gap-2">
        <SymbolLink symbol={card.symbol} name={card.name} security={card.security} />
        <span className="text-meta text-muted">· {card.headline}</span>
      </div>

      <figure className="mt-4">
        <figcaption className="label mb-1.5">
          {formatInZone(card.occurredAt, card.security.timeZone).split(",")[0]}{" "}
          &mdash; one {card.security.exchange ?? "trading"} session
        </figcaption>
        <div className="relative h-6 rounded-sm bg-line/60">
          <div
            className="absolute top-0 h-6 rounded-sm bg-missed"
            style={{ left: `${left}%`, width: `${width}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-micro text-faint">
          <span>{window.openLabel}</span>
          <span className="num text-missed">
            {formatInZone(card.occurredAt, card.security.timeZone).split(", ")[1]} → {formatInZone(card.resolvedAt, card.security.timeZone).split(", ")[1]}
          </span>
          <span>{window.closeLabel}</span>
        </div>
      </figure>

      <p className="mt-3 text-micro text-faint">
        You were away from {at(card.awayFrom, card.security)} to {at(card.awayUntil, card.security)}.
      </p>

      {/*
        Rendered from the actual daily bar for that session — never asserted, and
        omitted entirely when we cannot prove it. This is the strongest claim the
        product makes, so it has to be earned per event.
      */}
      {card.dailyBlindSpot && (
        <p className="mt-3 border-t border-line pt-3 text-body">
          Closed at{" "}
          <span className="num font-medium">{money(card.dailyBlindSpot.close, card.security)}</span>
          {card.dailyBlindSpot.exactlyAtLevel ? (
            <> &mdash; exactly the level it crossed.</>
          ) : (
            <>
              , back {card.dailyBlindSpot.direction === "above" ? "below" : "above"}{" "}
              <span className="num">{money(card.dailyBlindSpot.level, card.security)}</span>.
            </>
          )}{" "}
          <span className="text-muted">On daily closes this would not appear at all.</span>
        </p>
      )}

      {card.evidence.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-meta text-muted hover:text-ink">Evidence</summary>
          <div className="mt-3 border-t border-line pt-3">
            <Evidence entries={card.evidence} />
          </div>
        </details>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- anomaly */

export function Anomaly({ card }: { card: AnomalyCard }) {
  return (
    <article className="border-l-2 border-line-strong py-3 pl-4 pr-4">
      <header className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <SymbolLink symbol={card.symbol} name={card.name} security={card.security} />
          <span className="text-meta text-muted">· {card.signalType.replace(/_/g, " ")}</span>
        </div>
        <time className="text-micro text-faint">{at(card.occurredAt, card.security)}</time>
      </header>
      {card.evidence.length > 0 && (
        <div className="mt-2">
          <Evidence entries={card.evidence.slice(0, 4)} />
        </div>
      )}
    </article>
  );
}
