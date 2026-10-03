"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import {
    HeartPulse,
    Flame,
    TrendingUp,
    TrendingDown,
    Minus,
    Sparkles,
    Dumbbell,
    Moon,
    BookOpen,
    Wind,
    Users,
    Palette,
} from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import MoodChart from "@/components/mood/MoodChart";
import Spinner from "@/components/ui/Spinner";
import AIDisclaimer from "@/components/ui/AIDisclaimer";
import AiSourceBadge from "@/components/ui/AiSourceBadge";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import {
    useMoodHistory,
    useMoodStats,
    useLogMood,
    useWellnessSuggestions,
} from "@/hooks/queries/useMoodQuery";

const MOOD_OPTIONS = [
    { value: 1, labelKey: "veryLow", emoji: "😞", color: "bg-red-400" },
    { value: 2, labelKey: "low", emoji: "😟", color: "bg-orange-400" },
    { value: 3, labelKey: "okay", emoji: "😐", color: "bg-amber-400" },
    { value: 4, labelKey: "good", emoji: "🙂", color: "bg-lime-400" },
    { value: 5, labelKey: "great", emoji: "😄", color: "bg-emerald-500" },
];

const FACTOR_OPTIONS = [
    { value: "sleep", label: "Sleep", emoji: "😴" },
    { value: "exercise", label: "Exercise", emoji: "🏃" },
    { value: "social", label: "Social", emoji: "👥" },
    { value: "work", label: "Work", emoji: "💼" },
    { value: "stress", label: "Stress", emoji: "🌪️" },
];

const RESOURCE_ICONS: Record<string, any> = {
    exercise: Dumbbell,
    meditation: Moon,
    journaling: BookOpen,
    breathing: Wind,
    social: Users,
    creative: Palette,
};

export default function MoodPage() {
    const tf = useTranslations("features.moodFactors");
    const tm = useTranslations("mood");
    const tc = useTranslations("common");
    const { user } = useAuth();
    const [selectedMood, setSelectedMood] = useState<number | null>(null);
    const [notes, setNotes] = useState("");
    const [factors, setFactors] = useState<string[]>([]);

    const { data: entries = [], isLoading } = useMoodHistory(14);
    const { data: stats } = useMoodStats();
    const logMood = useLogMood();
    const suggestionsMutation = useWellnessSuggestions();
    const suggestions = suggestionsMutation.data?.suggestions || [];
    const suggestionsSource = suggestionsMutation.data?.source;

    const toggleFactor = (factor: string) =>
        setFactors((prev) => (prev.includes(factor) ? prev.filter((f) => f !== factor) : [...prev, factor]));

    const submit = () => {
        if (!selectedMood) return;
        logMood.mutate(
            { mood: selectedMood, notes: notes.trim() || undefined, factors: factors.length ? factors : undefined },
            {
                onSuccess: () => {
                    setNotes("");
                    setSelectedMood(null);
                    setFactors([]);
                },
            }
        );
    };

    const TrendIcon = stats?.trend === "improving" ? TrendingUp : stats?.trend === "declining" ? TrendingDown : Minus;
    const trendColor = stats?.trend === "improving" ? "text-emerald-600" : stats?.trend === "declining" ? "text-rose-600" : "text-gray-500";

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    return (
        <DashboardLayout>
            <div className="mb-10">
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">{tm("title")}</h1>
                <p className="text-gray-500 mt-2">{tm("subtitle")}</p>
            </div>

            {isLoading ? (
                <div className="grid lg:grid-cols-3 gap-6">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-64 bg-white border border-gray-100 rounded-3xl animate-pulse" />
                    ))}
                </div>
            ) : (
                <div className="grid lg:grid-cols-3 gap-6">
                    {/* Log mood */}
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-4 flex items-center gap-2">
                            <HeartPulse className="w-5 h-5 text-rose-500" /> {tm("howFeeling")}
                        </h2>
                        <div className="grid grid-cols-5 gap-2 mb-5">
                            {MOOD_OPTIONS.map((m) => (
                                <button
                                    key={m.value}
                                    onClick={() => setSelectedMood(m.value)}
                                    className={cn(
                                        "flex flex-col items-center gap-1 py-3 rounded-2xl border-2 transition-all",
                                        selectedMood === m.value
                                            ? "border-rose-400 bg-rose-50 scale-105"
                                            : "border-gray-50 hover:border-rose-100 hover:bg-rose-50/30"
                                    )}
                                >
                                    <span className="text-2xl">{m.emoji}</span>
                                    <span className="text-[9px] font-bold text-gray-400 uppercase">{tm(m.labelKey)}</span>
                                </button>
                            ))}
                        </div>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={3}
                            placeholder={tm("addNote")}
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-rose-500/20 text-sm font-medium resize-none mb-4"
                        />
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 ml-1">{tf("label")}</p>
                        <div className="flex flex-wrap gap-2 mb-4">
                            {FACTOR_OPTIONS.map((f) => (
                                <button
                                    key={f.value}
                                    type="button"
                                    onClick={() => toggleFactor(f.value)}
                                    className={cn(
                                        "px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all flex items-center gap-1",
                                        factors.includes(f.value)
                                            ? "border-rose-400 bg-rose-50 text-rose-600"
                                            : "border-gray-100 bg-gray-50 text-gray-400 hover:border-rose-100"
                                    )}
                                >
                                    <span>{f.emoji}</span>
                                    {f.label}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={submit}
                            disabled={!selectedMood || logMood.isPending}
                            className="w-full py-3.5 bg-rose-500 text-white rounded-2xl font-bold hover:bg-rose-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-rose-200"
                        >
                            {logMood.isPending ? <Spinner size="sm" className="text-white" /> : <HeartPulse className="w-4 h-4" />}
                            {tm("logMood")}
                        </button>
                    </motion.div>

                    {/* Stats */}
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-4">{tm("yourInsights")}</h2>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-indigo-50/60">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-indigo-500 text-white flex items-center justify-center"><HeartPulse className="w-5 h-5" /></div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase">{tm("avg30")}</p>
                                        <p className="text-2xl font-black text-gray-900">{stats?.average ?? "—"} <span className="text-sm font-bold text-gray-400">/ 5</span></p>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-amber-50/60">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center"><Flame className="w-5 h-5" /></div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase">{tm("logStreak")}</p>
                                        <p className="text-2xl font-black text-gray-900">{stats?.streak ?? 0} <span className="text-sm font-bold text-gray-400">{tm("days")}</span></p>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-emerald-50/60">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center"><TrendIcon className="w-5 h-5" /></div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase">{tm("trend")}</p>
                                        <p className={cn("text-2xl font-black capitalize", trendColor)}>{stats?.trend ?? "—"}</p>
                                    </div>
                                </div>
                            </div>
                            <p className="text-xs text-gray-400 italic">Logged {stats?.total ?? 0} entries in the last 30 days</p>
                        </div>
                        {stats?.factorCorrelation && Object.keys(stats.factorCorrelation).length > 0 && (
                            <div className="mt-4 pt-4 border-t border-gray-100">
                                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">{tf("factorImpact")}</p>
                                <div className="space-y-2">
                                    {Object.entries(stats.factorCorrelation).map(([factor, avg]) => {
                                        const meta = FACTOR_OPTIONS.find((f) => f.value === factor);
                                        return (
                                            <div key={factor} className="flex items-center gap-3">
                                                <span className="text-sm w-24 shrink-0 text-gray-600 font-semibold">{meta?.emoji} {meta?.label}</span>
                                                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                                    <div
                                                        className={cn("h-full rounded-full", (avg as number) >= 3.5 ? "bg-emerald-400" : (avg as number) >= 2.5 ? "bg-amber-400" : "bg-rose-400")}
                                                        style={{ width: `${((avg as number) / 5) * 100}%` }}
                                                    />
                                                </div>
                                                <span className="text-xs font-bold text-gray-500 w-8 text-right">{String(avg)}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </motion.div>

                    {/* Chart */}
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-6">{tm("last14")}</h2>
                        <MoodChart entries={entries} />
                    </motion.div>
                </div>
            )}

            {/* AI Wellness Suggestions */}
            <div className="mt-8">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-2xl font-extrabold text-gray-900 flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-violet-500" /> {tm("personalized")}
                    </h2>
                    <button
                        onClick={() => suggestionsMutation.mutate()}
                        disabled={suggestionsMutation.isPending}
                        className="px-4 py-2 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 transition-all disabled:opacity-50 flex items-center gap-2"
                    >
                        {suggestionsMutation.isPending ? <Spinner size="sm" className="text-white" /> : <Sparkles className="w-4 h-4" />}
                        {suggestions.length ? tc("refresh") : tm("suggestActivities")}
                    </button>
                </div>
                {suggestions.length > 0 ? (
                    <>
                        <div className="mb-4">
                            <AiSourceBadge source={suggestionsSource} />
                        </div>
                        <div className="grid md:grid-cols-3 gap-5">
                        {suggestions.map((s, i) => {
                            const Icon = RESOURCE_ICONS[s.type] || Sparkles;
                            return (
                                <motion.div
                                    key={i}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.1 }}
                                    className="bg-white rounded-3xl border border-gray-100 p-6 hover:shadow-xl hover:shadow-violet-500/5 transition-all"
                                >
                                    <div className="w-12 h-12 rounded-2xl bg-violet-50 text-violet-600 flex items-center justify-center mb-4">
                                        <Icon className="w-6 h-6" />
                                    </div>
                                    <h3 className="font-extrabold text-gray-900 mb-2">{s.title}</h3>
                                    <p className="text-sm text-gray-500 leading-relaxed">{s.description}</p>
                                </motion.div>
                            );
                        })}
                        </div>
                        <div className="mt-6">
                            <AIDisclaimer />
                        </div>
                    </>
                ) : (
                    <div className="bg-white border border-dashed border-gray-200 rounded-3xl py-12 text-center">
                        <Sparkles className="w-10 h-10 text-gray-300 mx-auto mb-4" />
                        <p className="text-gray-500 font-medium">{tm("suggestionsHint")}</p>
                        <button
                            onClick={() => suggestionsMutation.mutate()}
                            disabled={suggestionsMutation.isPending}
                            className="mt-4 px-6 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 transition-all disabled:opacity-50"
                        >
                            {suggestionsMutation.isPending ? "..." : tm("generateSuggestions")}
                        </button>
                    </div>
                )}
            </div>
        </DashboardLayout>
    );
}
