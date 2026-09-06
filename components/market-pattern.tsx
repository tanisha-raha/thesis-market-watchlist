import { DashboardCard } from "@/components/ui";
import { Evidence } from "@/components/evidence";
import { anomalyEvidence } from "@/lib/ml/anomaly";
import { formatExchangeTime } from "@/lib/time";
import type { StoredAnomaly } from "@/lib/ml/anomaly-server";

/**
 * The anomaly layer's one visible surface, and deliberately a quiet one.
 *
 * TWO STATEMENTS, KEPT APART. The model says one thing only: the combination of
 * signals recorded for this session was unusual for this security. The evidence
 * below it is the actual input the model saw, in real units — it is context a
 * reader can check, NOT a feature attribution. Isolation Forest does not explain
 * which feature made a point unusual, so claiming "unusual because volume rose"
 * would be inventing an explanation the model never produced.
 *
 * No score is rendered. The raw model output is stored for reproducibility, but
 * "0.68" on a page reads as a rating, and this is not a rating.
 */
export function MarketPattern({ anomaly, timeZone, monitored }: {
  anomaly: StoredAnomaly | null;
  timeZone: string;
  /** Whether THESIS monitors this security at all — decides the empty state. */
  monitored: boolean;
}) {
  if (!anomaly) {
    // Never an error card. Either the security is not monitored, or the model
    // declined for want of history; both are ordinary, and neither is alarming.
    if (!monitored) return null;
    return <DashboardCard title="Market Pattern" action={<span className="eyebrow">SECONDARY EVIDENCE</span>} className="market-pattern mt-4">
      <div className="panel-body"><p className="text-meta text-faint">
        The anomaly model has not evaluated a session for this company yet. It needs a run of observed
        history before it can say whether a day is unusual, and THESIS’s deterministic detection is
        unaffected either way.
      </p></div>
    </DashboardCard>;
  }

  const unusual = anomaly.status === "UNUSUAL";
  const window = anomaly.window as { trainingRows?: number; from?: string; through?: string };
  return <DashboardCard
    title="Market Pattern"
    action={<span className={`status-badge ${unusual ? "amber" : "neutral"}`}>{unusual ? "UNUSUAL PATTERN" : "TYPICAL"}</span>}
    className="market-pattern mt-4">
    <div className="panel-body">
      <p className="text-body">
        {unusual
          ? `The combination of price movement, volume and benchmark-relative behaviour recorded for the ${anomaly.tradingDate} session is unusual compared with this company’s own recent observations.`
          : `Nothing unusual was found in the combination of signals recorded for the ${anomaly.tradingDate} session, measured against this company’s own recent observations.`}
      </p>
      {unusual && <div className="mt-4"><Evidence entries={anomalyEvidence(anomaly.features)} /></div>}
      <p className="text-micro text-faint mt-4">
        The model classified the combined market state. The signals above are the inputs it saw at detection
        time — they are context, not causal attributions, and no single one is claimed to have caused the
        classification.
      </p>
      <p className="text-micro text-faint mt-2">
        Secondary evidence. THESIS’s deterministic engine decides what changed and whether your condition was
        met; this layer only describes how ordinary the day looked. It is not a prediction, a rating, or advice.
      </p>
    </div>
    <p className="panel-caption">
      {anomaly.modelVersion}
      {window.trainingRows ? ` · fitted on ${window.trainingRows} observed sessions` : ""}
      {window.from && window.through ? ` (${window.from} → ${window.through})` : ""}
      {" · evaluated "}{formatExchangeTime(anomaly.evaluatedAt, timeZone)}
    </p>
  </DashboardCard>;
}

/** The digest badge. One word, no numbers, no model vocabulary. */
export function UnusualPatternBadge({ present }: { present?: boolean }) {
  if (!present) return null;
  return <span className="status-badge amber unusual-badge" title="The anomaly model classified this session's combination of signals as unusual for this company">Unusual pattern</span>;
}
