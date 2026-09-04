"use client";

import { FormEvent, useState } from "react";

type Message = { role: "assistant" | "user"; text: string; mode?: "LIVE" | "DEMO REPLAY"; error?: boolean };

const examples = [
  "What changed while I was away?",
  "What does 2.3 sigma mean?",
  "What is my thesis for this symbol?",
];

export function AskThesisDrawer({ currentSymbol }: { currentSymbol?: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  const ask = async (value: string) => {
    const clean = value.trim();
    if (!clean || loading) return;
    setQuestion("");
    setMessages((items) => [...items, { role: "user", text: clean }]);
    setLoading(true);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: clean, currentSymbol }),
      });
      const payload = await response.json() as { answer?: string; mode?: "LIVE" | "DEMO REPLAY"; error?: string };
      if (!response.ok || !payload.answer) throw new Error(payload.error ?? "Ask THESIS is temporarily unavailable.");
      const answer = payload.answer;
      setMessages((items) => [...items, { role: "assistant", text: answer, mode: payload.mode }]);
    } catch (error) {
      setMessages((items) => [...items, {
        role: "assistant", error: true,
        text: error instanceof Error ? error.message : "Ask THESIS is temporarily unavailable.",
      }]);
    } finally {
      setLoading(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void ask(question);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm border border-line px-2.5 py-1 text-meta text-accent transition-colors hover:border-line-strong hover:text-ink"
      >
        Ask THESIS
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-paper/55 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-labelledby="ask-thesis-title">
          <section className="flex h-full w-full max-w-md flex-col border-l border-line-strong bg-paper shadow-2xl">
            <header className="flex items-start justify-between border-b border-line px-5 py-5">
              <div>
                <h2 id="ask-thesis-title" className="text-section font-medium tracking-tight">Ask THESIS</h2>
                <p className="mt-1 max-w-sm text-meta text-muted">Ask about your watchlist, thesis, or the evidence THESIS has already detected.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="ml-4 text-meta text-muted hover:text-ink" aria-label="Close Ask THESIS">Close</button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
              {messages.length === 0 ? (
                <div className="rounded-sm border border-dashed border-line-strong p-4">
                  <p className="text-body text-muted">I explain committed THESIS evidence. I don’t make recommendations or predictions.</p>
                  <div className="mt-4 flex flex-col items-start gap-2">
                    {examples.map((example) => (
                      <button key={example} type="button" onClick={() => void ask(example)} className="text-left text-meta text-accent underline-offset-2 hover:text-ink hover:underline">
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : messages.map((message, index) => (
                <article key={`${message.role}-${index}`} className={`rounded-sm border px-3 py-3 ${message.role === "user" ? "border-line bg-surface" : message.error ? "border-contradiction/50 bg-contradiction-soft/40" : "border-line-strong bg-surface/60"}`}>
                  <p className="label mb-1">{message.role === "user" ? "You" : "Ask THESIS"}{message.mode === "DEMO REPLAY" ? " · Demo replay" : ""}</p>
                  <p className="whitespace-pre-wrap text-body text-ink">{message.text}</p>
                </article>
              ))}
              {loading && <p className="text-meta text-muted">Reading stored THESIS evidence…</p>}
            </div>

            <form onSubmit={submit} className="border-t border-line p-4">
              <label htmlFor="ask-thesis-input" className="sr-only">Ask THESIS a question</label>
              <textarea
                id="ask-thesis-input"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={800}
                rows={2}
                placeholder="Ask about your watchlist or evidence…"
                className="w-full resize-none rounded-sm border border-line-strong bg-surface px-3 py-2 text-body text-ink placeholder:text-faint"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="text-micro text-faint">Explanations only · no advice</p>
                <button type="submit" disabled={loading || !question.trim()} className="rounded-sm bg-accent px-3 py-1.5 text-meta font-medium text-paper transition-opacity disabled:cursor-not-allowed disabled:opacity-45">
                  Send
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
