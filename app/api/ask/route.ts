import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { answerFromContext, getAskContext } from "@/lib/ask-thesis";
import { ADVICE_RESPONSE, allowGeneralRequest, boundedConversation, generalExplanation } from "@/lib/finance-assistant";
import { classifyAsk } from "@/lib/ask-intent";
import { getWatchlist } from "@/lib/watchlist";
import { getThesisReplay } from "@/lib/thesis-replay-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 12000) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let body: { question?: unknown; currentSymbol?: unknown; mode?: unknown; history?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid request" }, { status: 400 }); }
  if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 800) {
    return NextResponse.json({ error: "Enter a question." }, { status: 400 });
  }

  try {
    // Classification sees the user's own watchlist, because "Why am I watching
    // SBILIFE?" is a question about their data and contains none of the words a
    // keyword list would recognise. One memoised read, shared with the context
    // assembly below when the question turns out to be grounded.
    const watchlist = await getWatchlist(user.id);
    const intent = classifyAsk(body.question, watchlist, typeof body.mode === "string" ? body.mode : null);

    if (intent === "ADVISORY") return NextResponse.json({ answer: ADVICE_RESPONSE, category: "NON-ADVISORY" });

    if (intent === "GENERAL") {
      const general = await generalExplanation(body.question, boundedConversation(body.history), { allowProvider: () => allowGeneralRequest(user.id) });
      // `degraded` is telemetry about where the answer came from, not a failure:
      // a built-in explanation is a complete answer and is never styled as one.
      return NextResponse.json({ answer: general.answer, degraded: general.degraded, source: general.source, category: "GENERAL" });
    }

    const context = await getAskContext(user.id, typeof body.currentSymbol === "string" ? body.currentSymbol : null);
    if (/\b(happened before|historical|replay this|test .*thesis)\b/i.test(body.question) && context.currentSymbol) {
      const replay = await getThesisReplay(user.id, context.currentSymbol);
      return NextResponse.json({ category: "THESIS DATA", mode: context.mode, answer: replay?.status === "ready" ? `THESIS Replay for ${context.currentSymbol}: ${replay.occurrences.length} observed daily-close occurrences across ${replay.sessions} sessions (${replay.from} to ${replay.through}); ${replay.resolved} resolved at a later close. ${replay.message} Historical analysis, not a prediction.` : replay?.message ?? "No user-scoped replay is available." });
    }
    return NextResponse.json({ ...answerFromContext(body.question, context), category: "THESIS DATA" });
  } catch {
    // This is intentionally isolated from the digest/watchlist requests. A chat
    // failure cannot take down any deterministic product surface.
    return NextResponse.json({ error: "Ask THESIS is temporarily unavailable. Your watchlist and digest are unchanged." }, { status: 503 });
  }
}
