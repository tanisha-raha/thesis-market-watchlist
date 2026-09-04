import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thesis",
  description: "A watchlist that remembers why you're watching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-5">
          <main className="flex-1 py-10">{children}</main>
          <footer className="border-t border-[--color-line] py-6 text-xs leading-relaxed text-[--color-muted]">
            <p>
              Thesis is an attention tool, not an advisory product. It reports changes to
              conditions you defined. It does not make recommendations, and nothing here is
              investment advice.
            </p>
            <p className="mt-2">
              Market data is delayed and provided as-is. Every price is shown with the time it
              was reported by the exchange.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
