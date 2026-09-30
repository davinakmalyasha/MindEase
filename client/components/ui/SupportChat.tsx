"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { MessageCircle, X, Send, HeartHandshake, Loader2 } from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    crisis?: boolean;
    escalated?: boolean;
    /**
     * Whether a live model wrote this reply. When false the text came from the
     * fixed help-topic list, and the bubble says so — someone reaching out in
     * distress should not have to guess whether a model actually read them.
     *
     * Crisis and escalation replies are always `fallback`: they are fixed
     * safety instructions carrying emergency numbers, and are deliberately
     * *not* marked as canned in the UI, so this flag must not be used to style
     * them as anything but urgent.
     */
    source?: "model" | "fallback";
}

const QUICK_REPLIES = [
    "How do I book a session?",
    "How does pricing work?",
    "Is my data private?",
    "Talk to a human",
];

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

export default function SupportChat() {
    const [open, setOpen] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            role: "assistant",
            content:
                "Hi, I'm Ease — the MindEase support assistant. I can help you with booking sessions, pricing, privacy, and more. What do you need?",
        },
    ]);
    const [input, setInput] = useState("");
    const [isTyping, setIsTyping] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isTyping, open]);

    const send = async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || isTyping) return;
        setInput("");
        setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
        setIsTyping(true);
        try {
            const history = messages
                .slice(-10)
                .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
            const res = await api.post("/support/chat", { message: trimmed.slice(0, 2000), history });
            const data = res.data?.data;
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: data?.reply || "Sorry, I couldn't process that — try again or email support@mindease.id.",
                    crisis: !!data?.crisis,
                    escalated: !!data?.escalated,
                    source: data?.source,
                },
            ]);
        } catch (error) {
            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: getErrorMessage(error, "Sorry, something went wrong. Please try again or email support@mindease.id.") },
            ]);
        } finally {
            setIsTyping(false);
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
                <div className="fixed bottom-24 right-6 z-[90] w-[calc(100vw-3rem)] max-w-sm bg-white rounded-3xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col h-[560px] max-h-[calc(100vh-8rem)]">
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

                    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
                        {messages.map((m, i) => (
                            <div key={i} className={cn("flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
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
                                {m.role === "assistant" && m.source === "fallback" && !m.crisis && !m.escalated && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 px-1">
                                        Standard reply
                                    </span>
                                )}
                            </div>
                        ))}
                        {isTyping && (
                            <div className="flex justify-start">
                                <div className="bg-white border border-gray-100 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm flex items-center gap-1.5">
                                    <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                                    <span className="text-xs text-gray-400 font-semibold">Ease is typing…</span>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="px-4 pt-3 pb-2 border-t border-gray-100 bg-white">
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {QUICK_REPLIES.map((q) => (
                                <button
                                    key={q}
                                    onClick={() => send(q)}
                                    className="text-[11px] font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-full px-3 py-1 transition-colors"
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
                                className="flex-1 px-4 py-2.5 text-sm rounded-2xl border border-gray-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all"
                            />
                            <button
                                onClick={() => send(input)}
                                disabled={!input.trim() || isTyping}
                                className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 transition-all shrink-0"
                                aria-label="Send message"
                            >
                                <Send className="w-4 h-4" />
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-2">
                            AI responses are for guidance only. In a crisis, use the hotlines. Not an emergency service.
                        </p>
                    </div>
                </div>
            )}
        </>
    );
}
