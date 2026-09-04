import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { searchSymbols } from "@/lib/watchlist";

export async function GET(request: Request) {
  // Search hits an upstream API, so it is not open to unauthenticated callers.
  if (!(await getSessionUser())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json(await searchSymbols(q));
}
