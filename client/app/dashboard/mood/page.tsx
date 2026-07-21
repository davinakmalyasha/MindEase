"use client";

import { useState } from "react";
import { motion } from "framer-motion";
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
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import {
    useMoodHistory,
    useMoodStats,
    useLogMood,
    useWellnessSuggestions,
} from "@/hooks/queries/useMoodQuery";

const MOOD_OPTIONS = [
    { value: 1, label: "Very Low", emoji: "ðŸ˜ž", color: "bg-red-400" },
    { value: 2, label: "Low", emoji: "ðŸ˜Ÿ", color: "bg-orange-400" },
    { value: 3, label: "Okay", emoji: "ðŸ˜", color: "bg-amber-400" },
    { value: 4, label: "Good", emoji: "ðŸ™‚", color: "bg-lime-400" },
    { value: 5, label: "Great", emoji: "ðŸ˜„", color: "bg-emerald-500" },
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
    const { user } = useAuth();
    const [selectedMood, setSelectedMood] = useState<number | null>(null);
    const [notes, setNotes] = useState("");

    const { data: entries = [], isLoading } = useMoodHistory(14);
    const { data: stats } = useMoodStats();
    const logMood = useLogMood();
    const suggestionsMutation = useWellnessSuggestions();
    const suggestions = suggestionsMutation.data || [];

    const submit = () => {
        if (!selectedMood) return;
        logMood.mutate(
            { mood: selectedMood, notes: notes.trim() || undefined },
            {
                onSuccess: () => {
                    setNotes("");
                    setSelectedMood(null);
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
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">
                    Mood <span className="text-rose-500">Tracker</span>
                </h1>
                <p className="text-gray-500 mt-2">Log how you feel daily and watch your emotional patterns unfold</p>
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
                            <HeartPulse className="w-5 h-5 text-rose-500" /> How are you feeling?
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
                                    <span className="text-[9px] font-bold text-gray-400 uppercase">{m.label}</span>
                                </button>
                            ))}
                        </div>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={3}
                            placeholder="Add a note about your day (optional)..."
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-rose-500/20 text-sm font-medium resize-none mb-4"
                        />
                        <button
                            onClick={submit}
                            disabled={!selectedMood || logMood.isPending}
                            className="w-full py-3.5 bg-rose-500 text-white rounded-2xl font-bold hover:bg-rose-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-rose-200"
                        >
                            {logMood.isPending ? <Spinner size="sm" className="text-white" /> : <HeartPulse className="w-4 h-4" />}
                            Log Mood
                        </button>
                    </motion.div>

                    {/* Stats */}
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-4">Your Insights</h2>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-indigo-50/60">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-indigo-500 text-white flex items-center justify-center"><HeartPulse className="w-5 h-5" /></div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase">30-day average</p>
                                        <p className="text-2xl font-black text-gray-900">{stats?.average ?? "â€”"} <span className="text-sm font-bold text-gray-400">/ 5</span></p>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-amber-50/60">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center"><Flame className="w-5 h-5" /></div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase">Log streak</p>
                                        <p className="text-2xl font-black text-gray-900">{stats?.streak ?? 0} <span className="text-sm font-bold text-gray-400">days</span></p>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-emerald-50/60">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center"><TrendIcon className="w-5 h-5" /></div>
                                    <div>
                                        <p className="text-xs font-bold text-gray-400 uppercase">Emotional trend</p>
                                        <p className={cn("text-2xl font-black capitalize", trendColor)}>{stats?.trend ?? "â€”"}</p>
                                    </div>
                                </div>
                            </div>
                            <p className="text-xs text-gray-400 italic">Logged {stats?.total ?? 0} entries in the last 30 days</p>
                        </div>
                    </motion.div>

                    {/* Chart */}
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-6">Last 14 Days</h2>
                        <MoodChart entries={entries} />
                    </motion.div>
                </div>
            )}

            {/* AI Wellness Suggestions */}
            <div className="mt-8">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-2xl font-extrabold text-gray-900 flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-violet-500" /> Personalized Wellness
                    </h2>
                    <button
                        onClick={() => suggestionsMutation.mutate()}
                        disabled={suggestionsMutation.isPending}
                        className="px-4 py-2 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 transition-all disabled:opacity-50 flex items-center gap-2"
                    >
                        {suggestionsMutation.isPending ? <Spinner size="sm" className="text-white" /> : <Sparkles className="w-4 h-4" />}
                        {suggestions.length ? "Refresh" : "Suggest Activities"}
                    </button>
                </div>
                {suggestions.length > 0 ? (
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
                ) : (
                    <div className="bg-white border border-dashed border-gray-200 rounded-3xl py-12 text-center">
                        <Sparkles className="w-10 h-10 text-gray-300 mx-auto mb-4" />
                        <p className="text-gray-500 font-medium">Get AI-powered activity suggestions based on your recent mood history.</p>
                        <button
                            onClick={() => suggestionsMutation.mutate()}
                            disabled={suggestionsMutation.isPending}
                            className="mt-4 px-6 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 transition-all disabled:opacity-50"
                        >
                            {suggestionsMutation.isPending ? "Generating..." : "Generate Suggestions"}
                        </button>
                    </div>
                )}
            </div>
        </DashboardLayout>
    );
}
