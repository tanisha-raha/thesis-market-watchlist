"use client";

import { useEffect } from "react";

/**
 * A digest is marked read only after it has rendered in the browser. The server
 * endpoint is monotonic and clamps the supplied cutoff to a completed batch, so a
 * duplicate effect or stale tab cannot skip an event.
 */
export function DigestReadReceipt({ cutoff }: { cutoff: string }) {
  useEffect(() => {
    // Same authenticated, monotonic write; no router refresh or action-queue wait.
    // A failed acknowledgement leaves the window unread rather than skipping it.
    void fetch("/api/digest/read", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cutoff }), keepalive: true,
    }).catch(() => {});
  }, [cutoff]);

  return null;
}
