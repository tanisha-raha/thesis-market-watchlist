/**
 * Thesis Health — how the user's stated reasoning is holding up.
 *
 * THIS IS NOT A RATING OF THE COMPANY. It says nothing about whether a business
 * is good, whether a share is cheap, or what it will do next. It reports on one
 * thing only: the condition this user wrote down, and what the deterministic
 * engine has already recorded about it. THESIS evaluates the reasoning; the
 * person evaluates the investment.
 *
 * DERIVED, NOT SCORED. There is no second opinion here and no new arithmetic:
 * health is a pure function of the thesis state machine (WATCHING / TRIGGERED /
 * CONTRADICTED / STILL_VALID) and the verdicts the engine committed. That is
 * deliberate — a competing scorer would eventually disagree with the engine, and
 * then the product would be telling the reader two different things.
 *
 * WHAT CANNOT MOVE IT. Missing history, a stale quote, a degraded feed and an
 * anomaly classification are all invisible to this function, because none of
 * them is evidence about a stated condition. An anomaly says a session looked
 * unusual for a company; it does not say a person's reasoning failed, and it is
 * never allowed to. Ordinary price movement reaches health only through the
 * engine's own thresholds, which require two independent conditions sustained
 * across three sessions before anything is called invalid.
 */

export type ThesisHealth = "STRONG" | "NEEDS_ATTENTION" | "MATERIALLY_WEAKENED" | "INVALIDATED";

export type HealthVerdict = { kind: string; occurredAt: Date };

export type HealthInput = {
  /** "none" means the user recorded no structured condition; health does not apply. */
  type: string;
  state: string;
  verdicts: HealthVerdict[];
};

export type ThesisHealthView = {
  health: ThesisHealth;
  /** One sentence, about the condition — never about the company. */
  reason: string;
  /** The committed verdict this reading rests on, when there is one. */
  since: Date | null;
};

export const HEALTH_LABEL: Record<ThesisHealth, string> = {
  STRONG: "STRONG",
  NEEDS_ATTENTION: "NEEDS ATTENTION",
  MATERIALLY_WEAKENED: "MATERIALLY WEAKENED",
  INVALIDATED: "INVALIDATED",
};

/** Restrained, and ordered: green, yellow, orange, red. */
export const HEALTH_TONE: Record<ThesisHealth, string> = {
  STRONG: "strong",
  NEEDS_ATTENTION: "attention",
  MATERIALLY_WEAKENED: "weakened",
  INVALIDATED: "invalidated",
};

const latest = (verdicts: HealthVerdict[], kind: string): HealthVerdict | null =>
  verdicts.filter((verdict) => verdict.kind === kind)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] ?? null;

/**
 * The mapping, in full.
 *
 *   INVALIDATED          the engine recorded a contradiction and it stands. That
 *                        requires two of three independent conditions holding on
 *                        the same session for three consecutive sessions, outside
 *                        the 24-hour observation floor — the engine's rule, not
 *                        a second one invented here.
 *
 *   MATERIALLY_WEAKENED  a contradiction was recorded and acknowledged, and the
 *                        condition has produced nothing since. The reasoning has
 *                        failed once and has not been met again; that is weaker
 *                        than untested, and weaker than met.
 *
 *   NEEDS_ATTENTION      the condition the user was waiting for was met and they
 *                        have not looked at it. This is the attention tool doing
 *                        its job, and it is not bad news about the thesis.
 *
 *   STRONG               nothing adverse is outstanding. The default, including
 *                        for a brand-new thesis with no history at all: absence
 *                        of evidence is never treated as evidence against.
 */
export function thesisHealth(input: HealthInput): ThesisHealthView | null {
  if (!input.type || input.type === "none") return null;

  if (input.state === "CONTRADICTED") {
    const verdict = latest(input.verdicts, "contradicted");
    return {
      health: "INVALIDATED",
      reason: "The engine recorded a contradiction: independent conditions held together across consecutive sessions. Your stated reason no longer holds as written.",
      since: verdict?.occurredAt ?? null,
    };
  }

  if (input.state === "TRIGGERED") {
    const verdict = latest(input.verdicts, "triggered");
    return {
      health: "NEEDS_ATTENTION",
      reason: "The condition you were waiting for was met and you have not reviewed it yet.",
      since: verdict?.occurredAt ?? null,
    };
  }

  // Contradicted before, acknowledged, and nothing has met the condition since.
  const contradiction = latest(input.verdicts, "contradicted");
  if (contradiction) {
    const recovered = input.verdicts.some((verdict) =>
      (verdict.kind === "triggered" || verdict.kind === "still_valid")
      && verdict.occurredAt.getTime() > contradiction.occurredAt.getTime());
    if (!recovered) {
      return {
        health: "MATERIALLY_WEAKENED",
        reason: "This condition was contradicted once and you acknowledged it. Nothing has met it since, so the reasoning stands weaker than when you wrote it.",
        since: contradiction.occurredAt,
      };
    }
  }

  return {
    health: "STRONG",
    reason: input.state === "STILL_VALID"
      ? "The condition you stated continues to hold in observed sessions."
      : "Nothing recorded contradicts the condition you stated. THESIS is watching it.",
    since: null,
  };
}

/** The disclaimer this state must always carry. One sentence, everywhere it appears. */
export const HEALTH_CAVEAT = "Thesis Health evaluates the condition you stated, not the company or its expected return.";
