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
        <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 sm:px-6">
          <main className="flex-1 py-8 sm:py-12">{children}</main>
          {/*
            Visible but out of the way: a hairline rule, faint text, and no
            emphasis. It is a standing statement, not a notice to be read twice.
          */}
          <footer className="mt-16 border-t border-line pt-5 pb-8 text-micro leading-relaxed text-faint">
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
