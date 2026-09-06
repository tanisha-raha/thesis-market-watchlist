import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { AuthenticatedShell } from "@/components/app-shell";

/** Initial entry authenticates here. EVERY page/action still authenticates independently. */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const rows = await getWatchlist(user.id);
  return <AuthenticatedShell userId={user.id} email={user.email} displayName={user.displayName} active="home" rows={rows} demo={process.env.THESIS_DATA_MODE === "demo"}>
    {children}
  </AuthenticatedShell>;
}
