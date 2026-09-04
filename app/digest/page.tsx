import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getDigest } from "@/lib/digest";
import { Anomaly, Contradiction, Missed, Trigger } from "@/components/digest-cards";
import { formatIST } from "@/lib/time";
import { AppShell } from "@/components/app-shell";
import { DigestReadReceipt } from "@/components/digest-read-receipt";

export const dynamic = "force-dynamic";

export default async function DigestPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const d = await getDigest(user.id);
  const counts = [
    { n: d.contradictions.length, label: "contradicted", tone: "text-contradiction" },
    { n: d.triggers.length, label: "triggered", tone: "text-trigger" },
    { n: d.missed.length, label: "missed", tone: "text-missed" },
    { n: d.unchanged.length, label: "unchanged", tone: "text-faint" },
  ];
  const nothingAtAll =
    d.contradictions.length + d.triggers.length + d.missed.length + d.anomalies.length === 0;

  return (
    <AppShell email={user.email} active="digest">
      <DigestReadReceipt cutoff={d.cutoff.toISOString()} />

      <section className="mt-8">
        <h2 className="text-title font-medium tracking-tight">While you were away</h2>
        <p className="mt-1 text-meta text-muted">
          {d.awayFrom ? <>Since {formatIST(d.awayFrom)} IST</> : <>Since you started watching</>}
          {" · "}
          {/*
            "Market closed since your last visit" is a different statement from
            "nothing changed", and the calendar is derived from observed bars.
          */}
          {d.marketClosedThroughout
            ? "market closed since your last visit"
            : `${d.sessionsInWindow} trading ${d.sessionsInWindow === 1 ? "session" : "sessions"}`}
        </p>

        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 border-y border-line py-3">
          {counts.map((c) => (
            <div key={c.label} className="flex items-baseline gap-1.5">
              <dd className={`num text-emphasis ${c.n > 0 ? c.tone : "text-faint"}`}>{c.n}</dd>
              <dt className={`text-meta ${c.n > 0 ? "text-muted" : "text-faint"}`}>{c.label}</dt>
            </div>
          ))}
        </dl>
      </section>

      {nothingAtAll && (
        <div className="mt-8 rounded-sm border border-dashed border-line-strong px-6 py-10 text-center text-body text-muted">
          {d.marketClosedThroughout
            ? "The market has been closed since your last visit. Nothing could have changed."
            : "Nothing has met, contradicted, or reversed against your conditions."}
          {" "}
          <Link href="/watchlist#add-stock" className="mt-3 inline-block text-meta text-accent underline-offset-2 hover:underline">
            Add a stock to watch
          </Link>
        </div>
      )}

      {/* Priority order: contradictions, triggers, missed, then generic anomalies. */}
      <div className="mt-8 space-y-4">
        {d.contradictions.map((c) => <Contradiction key={c.thesisId} card={c} />)}
        {d.triggers.map((c) => <Trigger key={c.thesisId} card={c} />)}
        {d.missed.map((c) => <Missed key={`${c.symbol}-${c.occurredAt.toISOString()}`} card={c} />)}
        {d.anomalies.map((c) => <Anomaly key={`${c.symbol}-${c.occurredAt.toISOString()}`} card={c} />)}
      </div>

      {d.unchanged.length > 0 && (
        <p className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line pt-4 text-meta">
          <span className="text-faint">○ {d.unchanged.length} unchanged</span>
          {/*
            Clickable, because "unchanged" is a claim a reader is entitled to
            check. It should mean genuinely nothing, not merely nothing detected.
          */}
          {d.unchanged.map((u) => (
            <Link
              key={u.symbol}
              href={`/symbol/${encodeURIComponent(u.symbol)}`}
              className="text-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {u.symbol}
            </Link>
          ))}
        </p>
      )}
    </AppShell>
  );
}
