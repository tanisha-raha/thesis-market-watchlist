import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { answerFromContext, getAskContext } from "@/lib/ask-thesis";
import { ADVICE_QUESTION, ADVICE_RESPONSE, allowGeneralRequest, boundedConversation, explainFinance, isThesisQuestion } from "@/lib/finance-assistant";
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
    if (ADVICE_QUESTION.test(body.question)) return NextResponse.json({ answer: ADVICE_RESPONSE, category: "GENERAL" });
    const grounded = isThesisQuestion(body.question) || body.mode === "THESIS DATA";
    if (!grounded) {
      if (!allowGeneralRequest(user.id)) return NextResponse.json({ answer: "Please wait a minute before asking another general finance question. Your THESIS data remains available.", degraded: true, category: "GENERAL" });
      return NextResponse.json({ ...await explainFinance(body.question, boundedConversation(body.history)), category: "GENERAL" });
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
