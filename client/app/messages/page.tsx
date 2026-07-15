"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { MessageCircle, Send, ChevronLeft } from "lucide-react";
import Navbar from "@/components/layout/Navbar";
import Avatar from "@/components/ui/Avatar";
import Spinner from "@/components/ui/Spinner";
import { useAuth } from "@/context/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
    useConversations,
    useMessageThread,
    useSendMessage,
} from "@/hooks/queries/useMessagesQuery";

interface Message {
    id: number;
    content: string;
    senderId: number;
    receiverId: number;
    createdAt: string;
    isRead: boolean;
}

export default function MessagesPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
            <MessagesContent />
        </Suspense>
    );
}

function MessagesContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const [activeUser, setActiveUser] = useState<any>(null);
    const [draft, setDraft] = useState("");
    const [showMobileThread, setShowMobileThread] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    const { data: conversations = [], isLoading: isLoadingConv } = useConversations();
    const { data: messages = [], isLoading: isLoadingMsgs } = useMessageThread(
        activeUser?.id ?? null,
        5000 // polling fallback; realtime pushes make it snappy
    );
    const sendMessage = useSendMessage();
    const queryClient = useQueryClient();

    // Open conversation from ?with= param
    useEffect(() => {
        const withId = searchParams.get("with");
        if (withId && conversations.length > 0) {
            const conv = conversations.find((c: any) => String(c.user.id) === withId);
            if (conv) {
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setActiveUser(conv.user);
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setShowMobileThread(true);
            }
        }
    }, [searchParams, conversations]);

    const openConversation = (conv: any) => {
        setActiveUser(conv.user);
        setShowMobileThread(true);
        router.replace("/messages", { scroll: false });
    };

    // Live updates via the realtime service when connected
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.message && activeUser) {
                if (detail.message.senderId === activeUser.id || detail.message.receiverId === activeUser.id) {
                    queryClient.invalidateQueries({ queryKey: ["messages"] });
                }
            }
        };
        window.addEventListener("realtime:message", handler);
        return () => window.removeEventListener("realtime:message", handler);
    }, [activeUser, router]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, activeUser]);

    const submit = () => {
        if (!draft.trim() || !activeUser) return;
        const content = draft.trim();
        setDraft("");
        sendMessage.mutate(
            { receiverId: activeUser.id, content },
            {
                onError: () => setDraft(content),
            }
        );
    };

    const formatTime = (iso: string) => {
        const d = new Date(iso);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        if (sameDay) return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
    };

    if (!user) return null;

    return (
        <main className="min-h-screen bg-gray-50">
            <Navbar />
            <div className="pt-24 pb-8 px-4 md:px-8 max-w-6xl mx-auto">
                <div className="flex flex-col md:flex-row gap-5 h-[calc(100vh-150px)]">
                    {/* Conversations list */}
                    <aside
                        className={cn(
                            "w-full md:w-80 shrink-0 bg-white rounded-3xl border border-gray-100 overflow-hidden flex flex-col",
                            showMobileThread ? "hidden md:flex" : "flex"
                        )}
                    >
                        <div className="p-5 border-b border-gray-50">
                            <h1 className="text-xl font-extrabold text-gray-900 flex items-center gap-2">
                                <MessageCircle className="w-5 h-5 text-indigo-500" /> Messages
                            </h1>
                            <p className="text-xs text-gray-400 mt-1">Chat with your doctor or patient</p>
                        </div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {isLoadingConv ? (
                                <div className="p-4 space-y-3">
                                    {[1, 2, 3].map((i) => (
                                        <div key={i} className="h-16 bg-gray-50 rounded-2xl animate-pulse" />
                                    ))}
                                </div>
                            ) : conversations.length === 0 ? (
                                <div className="p-8 text-center">
                                    <MessageCircle className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                                    <p className="text-sm font-semibold text-gray-500">No conversations yet</p>
                                    <p className="text-xs text-gray-400 mt-1">Chat becomes available after an appointment is confirmed.</p>
                                </div>
                            ) : (
                                conversations.map((conv) => (
                                    <button
                                        key={conv.user.id}
                                        onClick={() => openConversation(conv)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors border-b border-gray-50 hover:bg-indigo-50/40",
                                            activeUser?.id === conv.user.id && "bg-indigo-50/60"
                                        )}
                                    >
                                        <div className="relative">
                                            <Avatar src={conv.user.avatar} name={conv.user.name} size="md" />
                                            {conv.unreadCount > 0 && (
                                                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">
                                                    {conv.unreadCount}
                                                </span>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="font-bold text-gray-900 text-sm truncate">{conv.user.name}</p>
                                                <p className="text-[10px] text-gray-400 font-semibold shrink-0">{formatTime(conv.lastMessageAt)}</p>
                                            </div>
                                            <p className="text-xs text-gray-400 truncate mt-0.5">
                                                {conv.lastMessageFromMe ? "You: " : ""}{conv.lastMessage}
                                            </p>
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </aside>

                    {/* Thread */}
                    <section className={cn(
                        "flex-1 bg-white rounded-3xl border border-gray-100 overflow-hidden flex flex-col",
                        showMobileThread ? "flex" : "hidden md:flex"
                    )}>
                        {!activeUser ? (
                            <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                                <MessageCircle className="w-14 h-14 text-gray-200 mb-4" />
                                <h3 className="text-lg font-bold text-gray-700">Select a conversation</h3>
                                <p className="text-sm text-gray-400 mt-1 max-w-xs">Choose a conversation on the left to start chatting.</p>
                            </div>
                        ) : (
                            <>
                                {/* Thread header */}
                                <div className="px-5 py-4 border-b border-gray-50 flex items-center gap-3">
                                    <button
                                        onClick={() => setShowMobileThread(false)}
                                        className="md:hidden text-gray-400 hover:text-gray-600"
                                    >
                                        <ChevronLeft className="w-5 h-5" />
                                    </button>
                                    <Avatar src={activeUser.avatar} name={activeUser.name} size="sm" />
                                    <div>
                                        <p className="font-bold text-gray-900 text-sm">{activeUser.name}</p>
                                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{activeUser.role}</p>
                                    </div>
                                </div>

                                {/* Messages */}
                                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3 bg-gray-50/40">
                                    {isLoadingMsgs ? (
                                        <div className="flex justify-center pt-10"><Spinner /></div>
                                    ) : messages.length === 0 ? (
                                        <p className="text-center text-sm text-gray-400 pt-10">No messages yet â€” say hello!</p>
                                    ) : (
                                        messages.map((msg) => {
                                            const mine = msg.senderId === user.id;
                                            return (
                                                <motion.div
                                                    key={msg.id}
                                                    initial={{ opacity: 0, y: 8 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    className={cn("flex", mine ? "justify-end" : "justify-start")}
                                                >
                                                    <div className={cn(
                                                        "max-w-[75%] px-4 py-2.5 rounded-2xl text-sm font-medium leading-relaxed shadow-sm",
                                                        mine
                                                            ? "bg-indigo-600 text-white rounded-br-md"
                                                            : "bg-white text-gray-800 border border-gray-100 rounded-bl-md"
                                                    )}>
                                                        {msg.content}
                                                        <div className={cn(
                                                            "text-[9px] mt-1 font-semibold",
                                                            mine ? "text-indigo-200" : "text-gray-300"
                                                        )}>
                                                            {formatTime(msg.createdAt)}
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            );
                                        })
                                    )}
                                    <div ref={bottomRef} />
                                </div>

                                {/* Composer */}
                                <div className="p-4 border-t border-gray-50 flex items-center gap-3">
                                    <input
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
                                        placeholder="Type a message..."
                                        className="flex-1 px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-medium"
                                    />
                                    <button
                                        onClick={submit}
                                        disabled={!draft.trim() || sendMessage.isPending}
                                        className="w-11 h-11 rounded-2xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-indigo-200"
                                    >
                                        <Send className="w-5 h-5" />
                                    </button>
                                </div>
                            </>
                        )}
                    </section>
                </div>
            </div>
        </main>
    );
}
