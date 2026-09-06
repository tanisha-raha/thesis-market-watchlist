import { getSessionUser } from "@/lib/auth";
import { recordDigestReceipt } from "@/lib/digest-receipt";

/** Background acknowledgement must not occupy Next's navigation/action queue. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  const user = await getSessionUser();
  if (!user) return new Response(null, { status: 401 });
  const text = await request.text();
  if (text.length > 256) return new Response(null, { status: 413 });
  let body: { cutoff?: unknown };
  try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  if (!body || typeof body.cutoff !== "string" || !Number.isFinite(new Date(body.cutoff).getTime())) return new Response(null, { status: 400 });
  await recordDigestReceipt(user.id, body.cutoff);
  return new Response(null, { status: 204 });
}
