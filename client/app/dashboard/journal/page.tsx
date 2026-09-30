"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { BookOpen, Sparkles, Send, Pencil, Trash2, X, Check } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Spinner from "@/components/ui/Spinner";
import AIDisclaimer from "@/components/ui/AIDisclaimer";
import AiSourceBadge from "@/components/ui/AiSourceBadge";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/context/AuthContext";
import {
    useJournalEntries,
    useCreateJournalEntry,
    useSummarizeJournal,
    useUpdateJournalEntry,
    useDeleteJournalEntry,
} from "@/hooks/queries/useMoodQuery";

export default function JournalPage() {
    const t = useTranslations("features.journal");
    const { user } = useAuth();
    const confirm = useConfirm();
    const [content, setContent] = useState("");
    const [aiSummary, setAiSummary] = useState<string | null>(null);
    const [aiSummarySource, setAiSummarySource] = useState<"model" | "fallback" | undefined>(undefined);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editText, setEditText] = useState("");

    const { data: entries = [], isLoading } = useJournalEntries(20);
    const createEntry = useCreateJournalEntry();
    const summarize = useSummarizeJournal();
    const updateEntry = useUpdateJournalEntry();
    const deleteEntry = useDeleteJournalEntry();

    const submit = () => {
        const text = content.trim();
        if (!text) return;
        createEntry.mutate(text, {
            onSuccess: () => setContent(""),
        });
    };

    const startEdit = (id: number, text: string) => {
        setEditingId(id);
        setEditText(text);
    };

    const saveEdit = () => {
        if (editingId == null || !editText.trim()) return;
        updateEntry.mutate(
            { id: editingId, content: editText.trim() },
            { onSuccess: () => setEditingId(null) }
        );
    };

    const generateSummary = () => {
        summarize.mutate(undefined, {
            onSuccess: (data) => {
                setAiSummary(data.summary);
                setAiSummarySource(data.source);
            },
        });
    };

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    return (
        <DashboardLayout>
            <div className="mb-10">
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">
                    My <span className="text-indigo-500">Journal</span>
                </h1>
                <p className="text-gray-500 mt-2">{t("subtitle")}</p>
            </div>

            <div className="grid lg:grid-cols-5 gap-6">
                {/* Write */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="lg:col-span-2 bg-white rounded-3xl border border-gray-100 p-6 h-fit sticky top-24">
                    <h2 className="text-lg font-extrabold text-gray-900 mb-4 flex items-center gap-2">
                        <BookOpen className="w-5 h-5 text-indigo-500" /> {t("writeTitle")}
                    </h2>
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        rows={10}
                        placeholder={t("writePlaceholder")}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-medium resize-none"
                    />
                    <button
                        onClick={submit}
                        disabled={!content.trim() || createEntry.isPending}
                        className="w-full mt-4 py-3.5 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-indigo-200"
                    >
                        {createEntry.isPending ? <Spinner size="sm" className="text-white" /> : <Send className="w-4 h-4" />}
                        {t("saveEntry")}
                    </button>

                    <div className="mt-6 pt-6 border-t border-gray-100">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="font-extrabold text-gray-900 flex items-center gap-2 text-sm">
                                <Sparkles className="w-4 h-4 text-violet-500" /> {t("aiReflection")}
                            </h3>
                            <button
                                onClick={generateSummary}
                                disabled={summarize.isPending || entries.length === 0}
                                className="px-3 py-1.5 rounded-xl bg-violet-500 text-white text-xs font-bold hover:bg-violet-600 transition-all disabled:opacity-50 flex items-center gap-1.5"
                            >
                                {summarize.isPending ? <Spinner size="sm" className="text-white" /> : <Sparkles className="w-3 h-3" />}
                                {aiSummary ? t("regenerate") : t("summarize")}
                            </button>
                        </div>
                        {aiSummary ? (
                            <>
                                <div className="mb-2">
                                    <AiSourceBadge source={aiSummarySource} />
                                </div>
                                <p className="text-sm text-gray-600 leading-relaxed bg-violet-50/60 border border-violet-100 rounded-2xl p-4 italic">{aiSummary}</p>
                            </>
                        ) : (
                            <p className="text-xs text-gray-400">{t("summaryHint")}</p>
                        )}
                        <div className="mt-3"><AIDisclaimer /></div>
                    </div>
                </motion.div>

                {/* History */}
                <div className="lg:col-span-3 space-y-4">
                    {isLoading ? (
                        <div className="space-y-4">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="h-40 bg-white border border-gray-100 rounded-3xl animate-pulse" />
                            ))}
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="bg-white border border-dashed border-gray-200 rounded-3xl py-16 text-center">
                            <BookOpen className="w-10 h-10 text-gray-300 mx-auto mb-4" />
                            <p className="text-gray-500 font-medium">{t("empty")}</p>
                        </div>
                    ) : (
                        entries.map((entry, i) => (
                            <motion.div
                                key={entry.id}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.05 }}
                                className="bg-white rounded-3xl border border-gray-100 p-6 hover:shadow-lg transition-all"
                            >
                                <div className="flex items-center justify-between mb-3">
                                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                        {new Date(entry.createdAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                                    </p>
                                    {editingId !== entry.id && (
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => startEdit(entry.id, entry.content)}
                                                title="Edit entry"
                                                className="p-2 rounded-xl text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                                            >
                                                <Pencil className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: "Delete this journal entry?",
                                                        message: "This cannot be undone.",
                                                        confirmLabel: "Delete",
                                                        danger: true,
                                                    });
                                                    if (ok) deleteEntry.mutate(entry.id);
                                                }}
                                                disabled={deleteEntry.isPending}
                                                title="Delete entry"
                                                className="p-2 rounded-xl text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition-all disabled:opacity-50"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                                {editingId === entry.id ? (
                                    <div className="space-y-3">
                                        <textarea
                                            value={editText}
                                            onChange={(e) => setEditText(e.target.value)}
                                            rows={6}
                                            autoFocus
                                            className="w-full px-4 py-3 bg-gray-50 border border-indigo-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-medium resize-none"
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                onClick={saveEdit}
                                                disabled={!editText.trim() || updateEntry.isPending}
                                                className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                            >
                                                {updateEntry.isPending ? <Spinner size="sm" className="text-white" /> : <Check className="w-3.5 h-3.5" />}
                                                Save
                                            </button>
                                            <button
                                                onClick={() => setEditingId(null)}
                                                className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-xs font-bold hover:bg-gray-200 transition-all flex items-center gap-1.5"
                                            >
                                                <X className="w-3.5 h-3.5" /> Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="text-gray-700 leading-relaxed whitespace-pre-wrap text-sm">{entry.content}</p>
                                )}
                            </motion.div>
                        ))
                    )}
                </div>
            </div>
        </DashboardLayout>
    );
}
