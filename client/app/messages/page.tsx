"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { MessageCircle, Send, ChevronLeft, Paperclip, FileText, Check, CheckCheck, Trash2, Search } from "lucide-react";
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
    useSendTyping,
    useUploadAttachment,
    useDeleteMessage,
    useSetReaction,
} from "@/hooks/queries/useMessagesQuery";

interface Message {
    id: number;
    content: string;
    senderId: number;
    receiverId: number;
    createdAt: string;
    isRead: boolean;
    readAt?: string | null;
    attachmentUrl?: string | null;
    attachmentType?: string | null;
    deletedAt?: string | null;
    reaction?: string | null;
}

const REACTIONS = ["👍", "❤️", "😂", "😮", "🙏"];

export default function MessagesPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
            <MessagesContent />
        </Suspense>
    );
}

function MessagesContent() {
    const t = useTranslations("features.chat");
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const [activeUser, setActiveUser] = useState<any>(null);
    const [draft, setDraft] = useState("");
    const [showMobileThread, setShowMobileThread] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const [typingPeer, setTypingPeer] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastTypingSentRef = useRef(0);

    const messageThreadKey = (userId: number) => ["messages", "thread", userId];

    const { data: conversations = [], isLoading: isLoadingConv } = useConversations();
    const { data: messages = [], isLoading: isLoadingMsgs } = useMessageThread(
        activeUser?.id ?? null,
        5000 // polling fallback; realtime pushes make it snappy
    );
    const sendMessage = useSendMessage();
    const sendTyping = useSendTyping();
    const uploadAttachment = useUploadAttachment();
    const deleteMessage = useDeleteMessage(activeUser?.id ?? 0);
    const setReaction = useSetReaction(activeUser?.id ?? 0);
    const queryClient = useQueryClient();
    const [searchQuery, setSearchQuery] = useState("");
    const [reactingTo, setReactingTo] = useState<number | null>(null);

    // Open conversation from ?with= param
    useEffect(() => {
        const withId = searchParams.get("with");
        if (withId && conversations.length > 0) {
            const conv = conversations.find((c: any) => String(c.user.id) === withId);
            if (conv) {
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setActiveUser(conv.user);
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
        const updateHandler = () => {
            if (activeUser) {
                queryClient.invalidateQueries({ queryKey: messageThreadKey(activeUser.id) });
            }
        };
        window.addEventListener("realtime:message", handler);
        window.addEventListener("realtime:message-update", updateHandler);
        return () => {
            window.removeEventListener("realtime:message", handler);
            window.removeEventListener("realtime:message-update", updateHandler);
        };
    }, [activeUser, router]);

    // Peer read receipts: when they read the thread, refresh to show checkmarks
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (activeUser && detail?.byUserId === activeUser.id) {
                queryClient.invalidateQueries({ queryKey: messageThreadKey(activeUser.id) });
                queryClient.invalidateQueries({ queryKey: ["messages", "conversations"] });
            }
        };
        window.addEventListener("realtime:read", handler);
        return () => window.removeEventListener("realtime:read", handler);
    }, [activeUser]);

    // Peer typing indicator. `typing:stop` clears the indicator immediately;
    // previously both frames were the same event, so stopping left it showing
    // for the full 2.5s timeout.
    useEffect(() => {
        const clear = () => {
            if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
            setTypingPeer(false);
        };
        const onStart = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (activeUser && detail?.userId === activeUser.id) {
                setTypingPeer(true);
                if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
                // A peer that never sends `typing:stop` (closed tab, dropped
                // socket) must not leave the indicator stuck.
                typingTimerRef.current = setTimeout(() => setTypingPeer(false), 2500);
            }
        };
        const onStop = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (activeUser && detail?.userId === activeUser.id) clear();
        };
        window.addEventListener("realtime:typing-start", onStart);
        window.addEventListener("realtime:typing-stop", onStop);
        return () => {
            window.removeEventListener("realtime:typing-start", onStart);
            window.removeEventListener("realtime:typing-stop", onStop);
            if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        };
    }, [activeUser]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, activeUser, typingPeer]);

    const fireTyping = useCallback(
        (typing: boolean) => {
            if (!activeUser) return;
            const now = Date.now();
            if (typing && now - lastTypingSentRef.current < 2000) return; // throttle starts
            lastTypingSentRef.current = now;
            sendTyping.mutate({ receiverId: activeUser.id, isTyping: typing });
        },
        [activeUser, sendTyping]
    );

    const stopTyping = useCallback(() => {
        if (!activeUser || !isTyping) return;
        setIsTyping(false);
        fireTyping(false);
    }, [activeUser, isTyping, fireTyping]);

    const onDraftChange = (value: string) => {
        setDraft(value);
        if (value.trim() && !isTyping) {
            setIsTyping(true);
            fireTyping(true);
        }
        if (!value.trim()) {
            stopTyping();
        }
    };

    const submit = () => {
        if (!draft.trim() || !activeUser) return;
        stopTyping();
        const content = draft.trim();
        setDraft("");
        sendMessage.mutate(
            { receiverId: activeUser.id, content },
            {
                onError: () => setDraft(content),
            }
        );
    };

    const handleAttach = async (file: File) => {
        if (!activeUser) return;
        if (file.size > 5 * 1024 * 1024) return;
        uploadAttachment.mutate(
            { file, receiverId: activeUser.id },
            {
                onSuccess: (attachment) => {
                    stopTyping();
                    sendMessage.mutate({ receiverId: activeUser.id, content: "", attachment });
                },
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

    const visibleMessages = searchQuery.trim()
        ? messages.filter((m: Message) => m.content.toLowerCase().includes(searchQuery.trim().toLowerCase()))
        : messages;

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
                                        {typingPeer ? (
                                            <p className="text-[11px] font-bold text-emerald-500">{t("typing")}</p>
                                        ) : (
                                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{activeUser.role}</p>
                                        )}
                                    </div>
                                    <div className="ml-auto relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" />
                                        <input
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            placeholder="Search..."
                                            className="pl-8 pr-3 py-1.5 bg-gray-50 border border-gray-100 rounded-xl text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 w-36"
                                        />
                                    </div>
                                </div>

                                {/* Messages */}
                                <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3 bg-gray-50/40">
                                    {isLoadingMsgs ? (
                                        <div className="flex justify-center pt-10"><Spinner /></div>
                                    ) : visibleMessages.length === 0 ? (
                                        <p className="text-center text-sm text-gray-400 pt-10">
                                            {searchQuery.trim() ? "No messages match your search." : "No messages yet — say hello!"}
                                        </p>
                                    ) : (
                                        visibleMessages.map((msg) => {
                                            const mine = msg.senderId === user.id;
                                            const isDeleted = !!msg.deletedAt;
                                            return (
                                                <motion.div
                                                    key={msg.id}
                                                    initial={{ opacity: 0, y: 8 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    className={cn("flex flex-col group", mine ? "items-end" : "items-start")}
                                                >
                                                    <div className={cn("relative flex", mine ? "justify-end" : "justify-start")}>
                                                        {mine && !isDeleted && (
                                                            <div className="absolute -left-16 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                <button
                                                                    onClick={() => setReactingTo(reactingTo === msg.id ? null : msg.id)}
                                                                    className="w-7 h-7 rounded-full bg-white border border-gray-200 flex items-center justify-center text-sm hover:bg-gray-50 shadow-sm"
                                                                    title="React"
                                                                >
                                                                    🙂
                                                                </button>
                                                                <button
                                                                    onClick={() => deleteMessage.mutate(msg.id)}
                                                                    className="w-7 h-7 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-400 hover:text-rose-500 hover:border-rose-200 shadow-sm"
                                                                    title="Delete"
                                                                >
                                                                    <Trash2 className="w-3.5 h-3.5" />
                                                                </button>
                                                            </div>
                                                        )}
                                                        {reactingTo === msg.id && (
                                                            <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-white border border-gray-200 rounded-full px-2 py-1 flex gap-1 shadow-lg z-10">
                                                                {REACTIONS.map((r) => (
                                                                    <button
                                                                        key={r}
                                                                        onClick={() => {
                                                                            setReaction.mutate({ messageId: msg.id, reaction: msg.reaction === r ? null : r });
                                                                            setReactingTo(null);
                                                                        }}
                                                                        className="text-lg hover:scale-125 transition-transform"
                                                                    >
                                                                        {r}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                        <div className={cn(
                                                            "max-w-[75%] px-4 py-2.5 rounded-2xl text-sm font-medium leading-relaxed shadow-sm",
                                                            mine
                                                                ? "bg-indigo-600 text-white rounded-br-md"
                                                                : "bg-white text-gray-800 border border-gray-100 rounded-bl-md"
                                                        )}>
                                                            {isDeleted ? (
                                                                <span className="italic opacity-60">Message deleted</span>
                                                            ) : (
                                                                <>
                                                                    {msg.attachmentUrl ? (
                                                                        msg.attachmentType === "image" ? (
                                                                            <a href={msg.attachmentUrl} target="_blank" rel="noopener noreferrer">
                                                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                                <img
                                                                                    src={msg.attachmentUrl}
                                                                                    alt="attachment"
                                                                                    className="max-w-full max-h-60 rounded-xl mb-1.5"
                                                                                />
                                                                            </a>
                                                                        ) : (
                                                                            <a
                                                                                href={msg.attachmentUrl}
                                                                                target="_blank"
                                                                                rel="noopener noreferrer"
                                                                                className={cn(
                                                                                    "flex items-center gap-2 mb-1.5 rounded-xl px-3 py-2 text-xs font-bold",
                                                                                    mine ? "bg-indigo-500 text-white" : "bg-gray-100 text-gray-700"
                                                                                )}
                                                                            >
                                                                                <FileText className="w-4 h-4" />
                                                                                {t("viewAttachment")}
                                                                            </a>
                                                                        )
                                                                    ) : null}
                                                                    {msg.content}
                                                                    {msg.reaction && (
                                                                        <span className="inline-flex items-center gap-1 ml-1 text-base align-middle">
                                                                            {msg.reaction}
                                                                        </span>
                                                                    )}
                                                                </>
                                                            )}
                                                            <div className={cn(
                                                                "text-[9px] mt-1 font-semibold flex items-center gap-1 justify-end",
                                                                mine ? "text-indigo-200" : "text-gray-300"
                                                            )}>
                                                                {formatTime(msg.createdAt)}
                                                                {mine && !isDeleted && (msg.readAt || msg.isRead ? (
                                                                    <CheckCheck className="w-3 h-3" />
                                                                ) : (
                                                                    <Check className="w-3 h-3" />
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            );
                                        })
                                    )}
                                    {typingPeer && (
                                        <div className="flex justify-start">
                                            <div className="px-4 py-2.5 bg-white border border-gray-100 rounded-2xl rounded-bl-md flex items-center gap-1">
                                                {[0, 1, 2].map((i) => (
                                                    <span
                                                        key={i}
                                                        className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                                                        style={{ animationDelay: `${i * 0.15}s` }}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    <div ref={bottomRef} />
                                </div>

                                {/* Composer */}
                                <div className="p-4 border-t border-gray-50 flex items-center gap-3">
                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        className="hidden"
                                        accept="image/*,.pdf,.doc,.docx,.txt"
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) handleAttach(file);
                                            e.target.value = "";
                                        }}
                                    />
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={uploadAttachment.isPending}
                                        className="w-11 h-11 rounded-2xl bg-gray-100 text-gray-500 flex items-center justify-center hover:bg-gray-200 transition-all disabled:opacity-40 shrink-0"
                                        title="Attach file"
                                    >
                                        {uploadAttachment.isPending ? <Spinner size="sm" /> : <Paperclip className="w-5 h-5" />}
                                    </button>
                                    <input
                                        value={draft}
                                        onChange={(e) => onDraftChange(e.target.value)}
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
