"use client";

import { useEffect } from "react";
import { markDigestRead } from "@/app/actions";

/**
 * A digest is marked read only after it has rendered in the browser. The server
 * action is monotonic and clamps the supplied cutoff to a completed batch, so a
 * duplicate effect or stale tab cannot skip an event.
 */
export function DigestReadReceipt({ cutoff }: { cutoff: string }) {
  useEffect(() => {
    void markDigestRead(cutoff);
  }, [cutoff]);

  return null;
}
