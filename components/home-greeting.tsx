"use client";
import { useEffect, useState } from "react";
import { homeGreeting } from "@/lib/user-profile";

/**
 * The greeting, corrected to the reader's own clock after mount.
 *
 * Rendered on the server first so there is no blank hero, then recomputed in the
 * browser's timezone — "good evening" at the user's breakfast was the giveaway
 * that this was really the server's clock. The name comes from the same stored
 * field everything else uses; nothing is derived from an email address.
 */
export function HomeGreeting({ name, initial }: { name: string | null; initial: string }) {
  const [greeting, setGreeting] = useState(initial);
  useEffect(() => {
    // `undefined` zone means the browser's own, which is the point of this component.
    setGreeting(homeGreeting(name, new Date(), undefined));
  }, [name]);
  return <>{greeting}</>;
}
