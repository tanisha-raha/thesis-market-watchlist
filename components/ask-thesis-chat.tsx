"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { BrandMark, Icon } from "@/components/ui";

type Message = { role: "assistant" | "user"; text: string; mode?: "LIVE" | "DEMO REPLAY"; category?: string; error?: boolean };

/** Dedicated conversation over the unchanged authenticated explanation endpoint. */
export function AskThesisChat({ currentSymbol, demo = false, userId }: { currentSymbol?: string; demo?: boolean; userId: number }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState("AUTO");
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try { const saved = JSON.parse(sessionStorage.getItem("thesis-conversation") ?? "null"); if (saved?.userId === userId && saved?.symbol === currentSymbol && Array.isArray(saved.messages)) setMessages(saved.messages.slice(-20)); else sessionStorage.removeItem("thesis-conversation"); } catch { /* unavailable storage */ }
    setRestored(true);
  }, [userId, currentSymbol]);
  useEffect(() => { if (restored) { try { sessionStorage.setItem("thesis-conversation", JSON.stringify({ userId, symbol: currentSymbol, messages: messages.slice(-20) })); } catch {} } }, [messages, restored, userId, currentSymbol]);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const examples = ["What changed while I was away?", currentSymbol ? `What is my thesis for ${currentSymbol}?` : "Has any condition been triggered?", "What does 2.3 sigma mean?", "What is the difference between NSE and NASDAQ?"];
  useEffect(() => {
    return () => { abort.current?.abort(); };
  }, []);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);
  const ask = async (value: string) => {
    const clean = value.trim();
    if (!clean || loading) return;
    setQuestion(""); setMessages((items) => [...items.slice(-19), { role: "user", text: clean }]); setLoading(true);
    const controller = new AbortController(); abort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: clean, currentSymbol, mode, history: messages.filter((m) => m.category === "GENERAL" || m.role === "user").slice(-6) }), signal: controller.signal });
      const payload = await response.json() as { answer?: string; mode?: "LIVE" | "DEMO REPLAY"; category?: string; error?: string; degraded?: boolean };
      if (!response.ok || !payload.answer) throw new Error(payload.error ?? "Ask THESIS is temporarily unavailable.");
      const answer = payload.answer;
      setMessages((items) => [...items, { role: "assistant", text: answer, mode: payload.mode, category: payload.category, error: payload.degraded }]);
    } catch {
      setMessages((items) => [...items, { role: "assistant", error: true, text: "Ask THESIS is temporarily unavailable. Please try again. Your watchlist and digest are unchanged." }]);
    } finally { clearTimeout(timeout); setLoading(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void ask(question); };
  const content = <section className="chat-panel" aria-label="Ask THESIS">
    <header className="chat-header"><div className="flex items-center gap-2"><BrandMark /><h1>Ask THESIS</h1><span className="status-badge positive">{demo ? "DEMO REPLAY" : "EXPLAIN"}</span></div><p>Your evidence, explained. Finance, made clearer.</p><label className="chat-mode">Conversation mode <select aria-label="Conversation mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="AUTO">Auto · evidence or education</option><option>THESIS DATA</option><option>GENERAL</option></select></label></header>
    <div ref={scroll} className="chat-conversation" role="log" aria-label="Ask THESIS conversation" aria-live="polite">
      {messages.length === 0 ? <>
        <div className="chat-greeting"><span className="text-ink font-medium">A little context goes a long way.</span><p>Understand your watchlist and conditions, explore recorded evidence, or learn a finance concept.</p></div>
        <p className="eyebrow mt-6 mb-3">START WITH A QUESTION</p>
        <div className="chat-prompts">{examples.map((example, index) => <button type="button" key={example} onClick={() => void ask(example)}><span><small className="eyebrow">{["YOUR WATCHLIST", "YOUR THESIS", "UNDERSTAND THE EVIDENCE", "LEARN"][index]}</small>{example}</span><Icon name="arrow" size={13} /></button>)}</div>
        <div className="chat-grounding"><Icon name="shield" size={16} /><p>THESIS DATA uses your stored evidence.<br />GENERAL offers optional finance education.</p></div>
      </> : messages.map((message, index) => <article key={index} className={`chat-message ${message.role} ${message.error ? "error" : ""}`}><p className="eyebrow mb-1">{message.role === "user" ? "YOU" : message.category ?? "ASK THESIS"}{message.mode === "DEMO REPLAY" && " · DEMO REPLAY"}</p><p>{message.text}</p></article>)}
      {loading && <p className="chat-loading" role="status"><span />Preparing your explanation…</p>}
    </div>
    <form onSubmit={submit} className="chat-composer"><div><label htmlFor="ask-thesis-input" className="sr-only">Ask THESIS a question</label><textarea ref={input} id="ask-thesis-input" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(question); } }} maxLength={800} rows={2} placeholder={currentSymbol ? `Ask about ${currentSymbol} or finance…` : "Ask about your watchlist or finance…"} /><button type="submit" aria-label="Send" disabled={loading || !question.trim()}><Icon name="send" size={18} /></button></div><p>Enter to send · Shift+Enter for a new line · AI explains. THESIS decides.</p></form>
  </section>;
  return content;
}
