import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thesis",
  description: "A watchlist that remembers why you're watching.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen flex-col">
          <main className="flex-1">{children}</main>
          {/*
            Visible but out of the way: a hairline rule, faint text, and no
            emphasis. It is a standing statement, not a notice to be read twice.
          */}
          <footer className="public-footer mx-auto w-full max-w-5xl border-t border-line px-4 pb-8 pt-5 text-micro leading-relaxed text-faint sm:px-6">
            <p>
              Thesis is an attention tool, not an advisory product. It reports changes to
              conditions you defined. It does not make recommendations, and nothing here is
              investment advice.
            </p>
            <p className="mt-1.5">
              Market data is delayed and provided as-is. Every price is shown with the time the
              exchange reported it.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
