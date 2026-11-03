"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { MessageCircle, X, Send, HeartHandshake, Loader2, Stethoscope, Brain, Check } from "lucide-react";
import api, { API_URL, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DoctorCard {
    id: string;
    name: string;
    specialty: string;
    experience: number;
    price: number;
    rating: number;
    link: string;
}

interface ToolEvent {
    name: string;
    ok: boolean;
    summary: string;
    doctors?: DoctorCard[];
}

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    crisis?: boolean;
    escalated?: boolean;
    source?: "model" | "fallback";
    doctors?: DoctorCard[];
    memoriesUsed?: boolean;
}

type Phase = "idle" | "thinking" | "tooling" | "streaming";

const QUICK_REPLIES = ["How do I book a session?", "Find me a psychologist for anxiety", "How does pricing work?", "Is my data private?"];

// Escape HTML BEFORE adding markup so AI/user text can never inject tags
const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const formatReply = (content: string) => {
    const safe = escapeHtml(content);
    const withLinks = safe.replace(
        /(https?:\/\/[^\s]+)/g,
        (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="underline font-semibold">${url}</a>`
    );
    return withLinks.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");
};

const formatIDR = (n: number) => "Rp" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const toolLabel = (name: string) => {
    if (name === "search_doctors") return "Searching psychologists";
    if (name === "memory_search" || name === "memory_get") return "Recalling notes";
    if (name === "memory_note") return "Saving to memory";
    return "Working";
};

async function fetchCsrf(): Promise<string | null> {
    try {
        const res = await api.get("/csrf-token");
        return res.data?.data?.csrfToken || null;
    } catch {
        return null;
    }
}

interface StreamResult {
    text: string;
    tools: ToolEvent[];
    doctors: DoctorCard[];
    source: "model" | "fallback";
    crisis: boolean;
    escalated: boolean;
    memoriesUsed: boolean;
}

async function streamChat(message: string, history: { role: string; content: string }[], onEvent: (kind: string, payload: string | ToolEvent) => void): Promise<StreamResult> {
    const csrf = await fetchCsrf();
    const res = await fetch(`${API_URL}/support/chat/stream`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        body: JSON.stringify({ message, history }),
    });
    if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    const tools: ToolEvent[] = [];
    let doctors: DoctorCard[] = [];
    let source: "model" | "fallback" = "fallback";
    let crisis = false;
    let escalated = false;
    let memoriesUsed = false;

    const handleEvent = (event: string, raw: string) => {
        let data: {
            text?: string;
            tool?: string;
            ok?: boolean;
            summary?: string;
            doctors?: DoctorCard[];
            source?: "model" | "fallback";
            crisis?: boolean;
            escalated?: boolean;
            memoriesUsed?: boolean;
            stage?: string;
        } = {};
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }
        if (event === "delta" && typeof data.text === "string") {
            text += data.text;
            onEvent("delta", data.text);
        } else if (event === "tool_call" && data.tool) {
            onEvent("tool_call", { name: data.tool, ok: true, summary: "" });
        } else if (event === "tool_result") {
            const t: ToolEvent = { name: String(data.tool), ok: !!data.ok, summary: String(data.summary || "") };
            if (Array.isArray(data.doctors)) {
                t.doctors = data.doctors;
                doctors = data.doctors;
            }
            tools.push(t);
            onEvent("tool_result", t);
        } else if (event === "done") {
            if (data.source === "model" || data.source === "fallback") source = data.source;
            if (data.crisis) crisis = true;
            if (data.escalated) escalated = true;
            if (data.memoriesUsed) memoriesUsed = true;
        }
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = block.split("\n");
            let event = "message";
            let data = "";
            for (const line of lines) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (data) handleEvent(event, data);
        }
    }
    return { text, tools, doctors, source, crisis, escalated, memoriesUsed };
}

export default function SupportChat() {
    const [open, setOpen] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            role: "assistant",
            content:
                "Hi, I'm Ease — the MindEase support assistant. I can help with booking sessions, find you a psychologist, explain pricing and privacy, and more. What do you need?",
        },
    ]);
    const [input, setInput] = useState("");
    const [phase, setPhase] = useState<Phase>("idle");
    const [activeTools, setActiveTools] = useState<string[]>([]);
    const [streamText, setStreamText] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);
    const reduceMotion = useReducedMotion();
    const busy = phase !== "idle";

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, streamText, activeTools, phase, open]);

    const send = async (text: string) => {
        const trimmed = text.trim().slice(0, 2000);
        if (!trimmed || busy) return;
        setInput("");
        setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
        setPhase("thinking");
        setActiveTools([]);
        setStreamText("");

        const history = messages
            .slice(-10)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

        try {
            const result = await streamChat(trimmed, history, (kind, payload) => {
                if (kind === "delta" && typeof payload === "string") {
                    setPhase("streaming");
                    setStreamText((prev) => prev + payload);
                } else if (kind === "tool_call") {
                    setPhase("tooling");
                    const t = payload as ToolEvent;
                    setActiveTools((prev) => (prev.includes(t.name) ? prev : [...prev, t.name]));
                } else if (kind === "tool_result") {
                    setActiveTools((prev) => prev.filter((n) => n !== (payload as ToolEvent).name));
                }
            });
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: result.text || "Sorry, I couldn't process that — try again or email support@mindease.id.",
                    crisis: result.crisis,
                    escalated: result.escalated,
                    source: result.source,
                    doctors: result.doctors.length ? result.doctors : undefined,
                    memoriesUsed: result.memoriesUsed || undefined,
                },
            ]);
        } catch (error) {
            // SSE failed (offline, CSRF, proxy buffering): fall back to the
            // non-streaming endpoint so the chat still answers.
            try {
                const res = await api.post("/support/chat", { message: trimmed, history });
                const data = res.data?.data;
                setMessages((prev) => [
                    ...prev,
                    {
                        role: "assistant",
                        content: data?.reply || "Sorry, I couldn't process that — try again or email support@mindease.id.",
                        crisis: !!data?.crisis,
                        escalated: !!data?.escalated,
                        source: data?.source,
                        doctors: data?.doctors?.length ? data.doctors : undefined,
                        memoriesUsed: data?.memoriesUsed || undefined,
                    },
                ]);
            } catch (fallbackError) {
                setMessages((prev) => [
                    ...prev,
                    { role: "assistant", content: getErrorMessage(fallbackError, getErrorMessage(error, "Sorry, something went wrong. Please try again or email support@mindease.id.")) },
                ]);
            }
        } finally {
            setPhase("idle");
            setActiveTools([]);
            setStreamText("");
        }
    };

    return (
        <>
            <button
                onClick={() => setOpen(!open)}
                aria-label="Open support chat"
                className="fixed bottom-6 right-6 z-[90] w-14 h-14 rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-500/30 flex items-center justify-center hover:scale-105 active:scale-95 transition-all"
            >
                {open ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
            </button>

            {open && (
                <div data-testid="support-chat-panel" className="fixed bottom-24 right-6 z-[90] w-[calc(100vw-3rem)] max-w-sm bg-white rounded-3xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col h-[560px] max-h-[calc(100vh-8rem)]">
                    <div className="px-5 py-4 bg-gradient-to-r from-indigo-600 to-violet-600 flex items-center justify-between">
                        <div>
                            <p className="font-black text-white">MindEase Support</p>
                            <p className="text-indigo-100 text-xs">AI assistant · replies instantly</p>
                        </div>
                        <Link
                            href="/crisis"
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/15 text-white text-[11px] font-black hover:bg-white/25 transition-colors"
                        >
                            <HeartHandshake className="w-3.5 h-3.5" /> Crisis help
                        </Link>
                    </div>

                    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50" aria-live="polite">
                        <AnimatePresence initial={false}>
                            {messages.map((m, i) => (
                                <motion.div
                                    key={i}
                                    data-testid={`chat-message-${m.role}`}
                                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.18 }}
                                    className={cn("flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}
                                >
                                    <div
                                        className={cn(
                                            "max-w-[85%] px-4 py-2.5 text-sm leading-relaxed rounded-2xl",
                                            m.role === "user"
                                                ? "bg-indigo-600 text-white rounded-br-md"
                                                : m.crisis
                                                ? "bg-rose-50 border border-rose-200 text-rose-800 rounded-bl-md"
                                                : "bg-white border border-gray-100 text-gray-700 rounded-bl-md shadow-sm"
                                        )}
                                        dangerouslySetInnerHTML={{ __html: formatReply(m.content) }}
                                    />
                                    {m.doctors && m.doctors.length > 0 && (
                                        <div className="w-full space-y-2 mt-1">
                                            {m.doctors.slice(0, 3).map((d) => (
                                                <Link
                                                    key={d.id}
                                                    href={d.link}
                                                    className="flex items-center gap-3 p-3 bg-white border border-indigo-100 rounded-2xl shadow-sm hover:border-indigo-300 hover:shadow transition-all"
                                                >
                                                    <span className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                                                        <Stethoscope className="w-4 h-4" />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block text-[13px] font-black text-gray-900 truncate">{d.name}</span>
                                                        <span className="block text-[11px] text-gray-500 truncate">
                                                            {d.specialty} · {formatIDR(d.price)} · ★ {Number(d.rating).toFixed(1)}
                                                        </span>
                                                    </span>
                                                    <span className="text-[11px] font-black text-indigo-600 shrink-0" aria-hidden>→</span>
                                                </Link>
                                            ))}
                                        </div>
                                    )}
                                    <div className="flex items-center gap-2 px-1">
                                        {m.role === "assistant" && m.source === "fallback" && !m.crisis && !m.escalated && (
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                                                Standard reply
                                            </span>
                                        )}
                                        {m.memoriesUsed && (
                                            <span className="inline-flex items-center gap-1 text-indigo-400 px-1" aria-hidden>
                                                <Brain className="w-3 h-3" />
                                            </span>
                                        )}
                                    </div>
                                </motion.div>
                            ))}
                        </AnimatePresence>
                        <AnimatePresence>
                            {busy && (
                                <motion.div
                                    key="status"
                                    data-testid="agent-status"
                                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    className="flex flex-col gap-2 items-start"
                                >
                                    {phase === "thinking" && activeTools.length === 0 && !streamText && (
                                        <div className="bg-white border border-gray-100 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm flex items-center gap-2">
                                            <span className="flex gap-1" aria-hidden>
                                                {[0, 1, 2].map((d) => (
                                                    <motion.span
                                                        key={d}
                                                        className="w-1.5 h-1.5 rounded-full bg-indigo-400"
                                                        animate={reduceMotion ? undefined : { opacity: [0.3, 1, 0.3] }}
                                                        transition={{ duration: 1.1, repeat: Infinity, delay: d * 0.18 }}
                                                    />
                                                ))}
                                            </span>
                                            <span className="text-xs text-gray-400 font-semibold">Ease is thinking…</span>
                                        </div>
                                    )}
                                    {activeTools.map((t) => (
                                        <div
                                            key={t}
                                            className="bg-indigo-50 border border-indigo-100 px-3.5 py-2 rounded-full flex items-center gap-2"
                                        >
                                            <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                                            <span className="text-xs text-indigo-600 font-bold">{toolLabel(t)}…</span>
                                        </div>
                                    ))}
                                    {streamText && (
                                        <div className="max-w-[85%] px-4 py-2.5 text-sm leading-relaxed rounded-2xl bg-white border border-gray-100 text-gray-700 rounded-bl-md shadow-sm">
                                            <span dangerouslySetInnerHTML={{ __html: formatReply(streamText) }} />
                                            <motion.span
                                                className="inline-block w-1.5 h-4 bg-indigo-400 ml-1 align-middle"
                                                animate={reduceMotion ? undefined : { opacity: [1, 0, 1] }}
                                                transition={{ duration: 0.9, repeat: Infinity }}
                                            />
                                        </div>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>
                        {phase === "idle" && activeTools.length === 0 && null}
                    </div>

                    <div className="px-4 pt-3 pb-2 border-t border-gray-100 bg-white">
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {QUICK_REPLIES.map((q) => (
                                <button
                                    key={q}
                                    onClick={() => send(q)}
                                    disabled={busy}
                                    className="text-[11px] font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-full px-3 py-1 transition-colors disabled:opacity-40"
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && send(input)}
                                placeholder="Type your question…"
                                aria-label="Type your question"
                                className="flex-1 px-4 py-2.5 text-sm rounded-2xl border border-gray-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all"
                            />
                            <button
                                onClick={() => send(input)}
                                disabled={!input.trim() || busy}
                                className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 transition-all shrink-0"
                                aria-label="Send message"
                            >
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-2 flex items-center gap-1">
                            <Check className="w-3 h-3" /> AI responses are for guidance only. In a crisis, use the hotlines. Not an emergency service.
                        </p>
                    </div>
                </div>
            )}
        </>
    );
}
