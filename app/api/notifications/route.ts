import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  generateNotifications, getPreferences, listNotifications, markAllRead, markRead,
  savePreferences, type NotificationPreferences,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * The notification centre's endpoint.
 *
 * GENERATION HAPPENS HERE, NOT IN A PAGE. The bell fetches after mount, so
 * deriving notifications from committed evidence never sits between a click and
 * a rendered page — the navigation work this product spent a lot of effort on
 * stays intact. The write is idempotent, so calling it on every open is fine.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await generateNotifications(user.id);
  const [items, preferences] = await Promise.all([listNotifications(user.id), getPreferences(user.id)]);
  return NextResponse.json({
    items: items.map((item) => ({ ...item, occurredAt: item.occurredAt.toISOString(), readAt: item.readAt?.toISOString() ?? null })),
    unread: items.filter((item) => item.readAt == null).length,
    preferences,
  });
}

const BOOLEANS: (keyof NotificationPreferences)[] = ["inApp", "onTrigger", "onNeedsAttention", "onWeakened", "onInvalidated", "onReversal"];

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { action?: unknown; id?: unknown; preferences?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid request" }, { status: 400 }); }

  if (body.action === "read-all") {
    await markAllRead(user.id);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "read" && typeof body.id === "number" && Number.isSafeInteger(body.id)) {
    // Scoped to this user inside the update predicate, never by trusting the id.
    await markRead(user.id, body.id);
    return NextResponse.json({ ok: true });
  }
  if (body.preferences && typeof body.preferences === "object") {
    const supplied = body.preferences as Record<string, unknown>;
    const next: Partial<NotificationPreferences> = {};
    for (const key of BOOLEANS) if (typeof supplied[key] === "boolean") next[key] = supplied[key];
    if (Object.keys(next).length === 0) return NextResponse.json({ error: "no preferences supplied" }, { status: 400 });
    return NextResponse.json({ preferences: await savePreferences(user.id, next) });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
