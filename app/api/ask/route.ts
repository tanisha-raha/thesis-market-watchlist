import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { boundedTurns, respond } from "@/lib/ask-conversation";

export const dynamic = "force-dynamic";

/** Transport only: authentication, input limits, and one call to the responder. */
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
    return NextResponse.json(await respond({
      userId: user.id,
      message: body.question,
      history: boundedTurns(body.history),
      currentSymbol: typeof body.currentSymbol === "string" ? body.currentSymbol : null,
      mode: typeof body.mode === "string" ? body.mode : null,
    }));
  } catch {
    // This is intentionally isolated from the digest/watchlist requests. A chat
    // failure cannot take down any deterministic product surface.
    return NextResponse.json({ error: "Ask THESIS is temporarily unavailable. Your watchlist and digest are unchanged." }, { status: 503 });
  }
}
