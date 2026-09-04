import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { answerFromContext, getAskContext } from "@/lib/ask-thesis";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { question?: unknown; currentSymbol?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid request" }, { status: 400 }); }
  if (typeof body.question !== "string" || !body.question.trim()) {
    return NextResponse.json({ error: "Enter a question." }, { status: 400 });
  }

  try {
    const context = await getAskContext(user.id, typeof body.currentSymbol === "string" ? body.currentSymbol : null);
    return NextResponse.json(answerFromContext(body.question, context));
  } catch {
    // This is intentionally isolated from the digest/watchlist requests. A chat
    // failure cannot take down any deterministic product surface.
    return NextResponse.json({ error: "Ask THESIS is temporarily unavailable. Your watchlist and digest are unchanged." }, { status: 503 });
  }
}
