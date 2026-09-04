import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export default async function Home() {
  redirect((await getSessionUser()) ? "/digest" : "/login");
}
