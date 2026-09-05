"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { BrandMark, Icon } from "@/components/ui";
import { useWorkspace } from "@/components/workspace-controls";
import { Modal } from "@/components/modal";

type Message = { role: "assistant" | "user"; text: string; mode?: "LIVE" | "DEMO REPLAY"; error?: boolean };

/** The same grounded conversation is docked on desktop and modal below 1280px. */
export function AskThesisPanel({ currentSymbol, demo = false }: { currentSymbol?: string; demo?: boolean }) {
  const { chatOpen, setChatOpen } = useWorkspace();
  const [desktop, setDesktop] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const examples = ["What changed while I was away?", currentSymbol ? `What is my thesis for ${currentSymbol}?` : "Which watched stocks had meaningful changes?", currentSymbol ? `Explain the latest ${currentSymbol} event.` : "What does 2.3 sigma mean?", "Is this live data or demo replay?"];
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setDesktop(media.matches);
    update(); media.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); abort.current?.abort(); };
  }, []);
  useEffect(() => { if (chatOpen) input.current?.focus(); }, [chatOpen, desktop]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);
  const ask = async (value: string) => {
    const clean = value.trim();
    if (!clean || loading) return;
    setQuestion(""); setMessages((items) => [...items.slice(-19), { role: "user", text: clean }]); setLoading(true);
    const controller = new AbortController(); abort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: clean, currentSymbol }), signal: controller.signal });
      const payload = await response.json() as { answer?: string; mode?: "LIVE" | "DEMO REPLAY"; error?: string };
      if (!response.ok || !payload.answer) throw new Error(payload.error ?? "Ask THESIS is temporarily unavailable.");
      const answer = payload.answer;
      setMessages((items) => [...items, { role: "assistant", text: answer, mode: payload.mode }]);
    } catch {
      setMessages((items) => [...items, { role: "assistant", error: true, text: "Ask THESIS is temporarily unavailable. Please try again. Your watchlist and digest are unchanged." }]);
    } finally { clearTimeout(timeout); setLoading(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void ask(question); };
  const content = <section className="chat-panel" aria-label="Ask THESIS">
    <header className="chat-header"><div className="flex items-center gap-2"><BrandMark /><h2>THESIS AI</h2><span className="status-badge positive">ASK</span></div><p>Your watchlist explanation assistant</p><button className="icon-button chat-close" aria-label="Close Ask THESIS" onClick={() => setChatOpen(false)}><Icon name="close" size={17} /></button></header>
    <div ref={scroll} className="chat-conversation" role="log" aria-label="Ask THESIS conversation" aria-live="polite">
      {messages.length === 0 ? <>
        <div className="chat-greeting"><span className="text-ink font-medium">A little context goes a long way.</span><p>Ask about your watchlist, the conditions you set, or the evidence THESIS has already detected.</p></div>
        <p className="eyebrow mt-6 mb-3">START WITH A QUESTION</p>
        <div className="chat-prompts">{examples.map((example) => <button type="button" key={example} onClick={() => void ask(example)}><span>{example}</span><Icon name="arrow" size={13} /></button>)}</div>
        <div className="chat-grounding"><Icon name="shield" size={16} /><p>Grounded in your THESIS data.<br />Explanations, never predictions.</p></div>
      </> : messages.map((message, index) => <article key={index} className={`chat-message ${message.role} ${message.error ? "error" : ""}`}><p className="eyebrow mb-1">{message.role === "user" ? "YOU" : "ASK THESIS"}{message.mode === "DEMO REPLAY" && " · DEMO REPLAY"}</p><p>{message.text}</p></article>)}
      {loading && <p className="chat-loading" role="status"><span />Reading your THESIS evidence…</p>}
    </div>
    <form onSubmit={submit} className="chat-composer"><div><label htmlFor="ask-thesis-input" className="sr-only">Ask THESIS a question</label><textarea ref={input} id="ask-thesis-input" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={800} rows={2} placeholder={currentSymbol ? `Ask about ${currentSymbol}…` : "Ask about your watchlist…"} /><button type="submit" aria-label="Send" disabled={loading || !question.trim()}><Icon name="send" size={18} /></button></div><p>{demo ? "DEMO REPLAY · " : ""}Your evidence. Your perspective.</p></form>
  </section>;
  if (desktop) return <aside className={`chat-dock ${chatOpen ? "is-focused" : ""}`} data-testid="desktop-chat">{content}</aside>;
  return <Modal open={chatOpen} onClose={() => setChatOpen(false)} label="Ask THESIS" className="chat-dialog">{content}</Modal>;
}
