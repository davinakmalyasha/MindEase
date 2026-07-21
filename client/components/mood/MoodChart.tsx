"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

const MOOD_COLORS: Record<number, string> = {
    1: "bg-red-400",
    2: "bg-orange-400",
    3: "bg-amber-400",
    4: "bg-lime-400",
    5: "bg-emerald-500",
};

const MOOD_LABELS: Record<number, string> = {
    1: "Very Low",
    2: "Low",
    3: "Okay",
    4: "Good",
    5: "Great",
};

export default function MoodChart({ entries }: { entries: { mood: number; createdAt: string }[] }) {
    const byDay = new Map<string, number>();
    for (const e of entries) {
        const d = new Date(e.createdAt);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        byDay.set(key, e.mood);
    }

    const days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (13 - i));
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        return {
            label: d.toLocaleDateString("en-US", { weekday: "short" }),
            day: d.getDate(),
            mood: byDay.get(key) ?? null,
        };
    });

    const max = Math.max(...days.map((d) => d.mood ?? 0), 5);

    return (
        <div>
            <div className="flex items-end justify-between gap-1.5 h-40">
                {days.map((d, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1.5 group">
                        <div className="relative w-full flex items-end justify-center" style={{ height: "100%" }}>
                            {d.mood !== null && (
                                <motion.div
                                    initial={{ height: 0 }}
                                    animate={{ height: `${(d.mood / max) * 100}%` }}
                                    transition={{ delay: i * 0.03, duration: 0.4 }}
                                    className={cn(
                                        "w-full max-w-[24px] rounded-t-lg transition-all group-hover:opacity-80",
                                        MOOD_COLORS[d.mood]
                                    )}
                                    title={`${MOOD_LABELS[d.mood]}`}
                                />
                            )}
                            {d.mood === null && (
                                <div className="w-full max-w-[24px] h-1 rounded-full bg-gray-100 mt-auto" />
                            )}
                        </div>
                    </div>
                ))}
            </div>
            <div className="flex justify-between mt-2">
                {days.map((d, i) => (
                    <div key={i} className="flex-1 text-center">
                        <p className="text-[9px] font-bold text-gray-400 uppercase">{d.label}</p>
                        <p className="text-[9px] text-gray-300">{d.day}</p>
                    </div>
                ))}
            </div>
            <div className="mt-4 flex items-center justify-center gap-4 flex-wrap">
                {[1, 2, 3, 4, 5].map((m) => (
                    <div key={m} className="flex items-center gap-1.5">
                        <span className={cn("w-2.5 h-2.5 rounded-full", MOOD_COLORS[m])} />
                        <span className="text-[10px] font-semibold text-gray-400">{MOOD_LABELS[m]}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
