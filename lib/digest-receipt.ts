import "server-only";
import { advanceDigestWatermark } from "@/lib/digest";
import { lastCommittedBatchAt } from "@/lib/ingestion";

/** Caller supplies the authenticated user, never a client-provided user id. */
export async function recordDigestReceipt(userId: number, cutoffIso: string): Promise<void> {
  const requested = new Date(cutoffIso);
  if (!Number.isFinite(requested.getTime())) return;
  const committed = await lastCommittedBatchAt();
  if (!committed) return;
  await advanceDigestWatermark(userId, requested <= committed ? requested : committed);
}
