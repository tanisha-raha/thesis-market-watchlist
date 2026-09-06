import { HEALTH_CAVEAT, HEALTH_LABEL, HEALTH_TONE, type ThesisHealth } from "@/lib/thesis-health";

/**
 * Thesis Health, shown the same way everywhere it appears.
 *
 * The label always says THESIS, never the ticker, because the one thing this
 * state must never be mistaken for is a view on the company. Four restrained
 * tones in one order — green, yellow, orange, red — and no arrow, score or
 * number, because a number invites arithmetic and there is none to do.
 */
export function ThesisHealthBadge({ health, compact = false }: { health: ThesisHealth; compact?: boolean }) {
  return <span className={`health-badge ${HEALTH_TONE[health]}${compact ? " compact" : ""}`} title={HEALTH_CAVEAT}>
    {compact ? HEALTH_LABEL[health] : `THESIS ${HEALTH_LABEL[health]}`}
  </span>;
}

/** The prominent block on Symbol Detail: the state, why, and what it is not. */
export function ThesisHealthPanel({ health, reason }: { health: ThesisHealth; reason: string }) {
  return <div className={`thesis-health ${HEALTH_TONE[health]}`}>
    <div className="thesis-health-head">
      <span className="eyebrow">THESIS HEALTH</span>
      <ThesisHealthBadge health={health} />
    </div>
    <p>{reason}</p>
    <small>{HEALTH_CAVEAT} THESIS evaluates the reasoning; you evaluate the investment.</small>
  </div>;
}
