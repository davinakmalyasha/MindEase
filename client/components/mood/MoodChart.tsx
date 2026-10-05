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

// Grouped by `moodDate` - the day key the API already computed in the *user's*
// zone - rather than by re-deriving a calendar day from `createdAt` in whatever
// timezone the browser happens to be in.
//
// The two agree only when the viewer's zone matches the user's. They did not
// have to: a patient in WIB opening the app from Singapore, or a clinician
// reviewing a patient's log from another region, would see the bars slide onto
// the wrong days. `moodDate` is the answer the server already computed and it is
// unambiguous, so there is no reason to recompute it locally.
const dayKeyOf = (moodDate: string) => moodDate;

export default function MoodChart({
    entries,
}: {
    entries: { mood: number; createdAt: string; moodDate: string }[];
}) {
    const byDay = new Map<string, number>();
    for (const e of entries) {
        byDay.set(dayKeyOf(e.moodDate), e.mood);
    }

    // The axis is walked in the same key space as the data, using the same
    // wall-clock arithmetic, so a bar can never land on a neighbouring day.
    const today = new Date();
    const days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - (13 - i));
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return {
            key,
            label: d.toLocaleDateString("en-US", { weekday: "short" }),
            day: d.getDate(),
            mood: byDay.get(key) ?? null,
        };
    });

    const max = Math.max(...days.map((d) => d.mood ?? 0), 5);

    const logged = days.filter((d) => d.mood !== null);
    // A chart of coloured bars carries its meaning entirely in colour and
    // position. That is unusable with a screen reader, unusable in print, and
    // unusable for the roughly 1 in 12 men with a colour vision deficiency - so
    // the same information is stated in text, once, for everyone.
    const summary = logged.length
        ? `Mood over the last 14 days. ${logged.length} of 14 days logged. ` +
          logged.map((d) => `${d.label} ${d.day}: ${MOOD_LABELS[d.mood as number]}`).join(". ") +
          "."
        : "Mood over the last 14 days. Nothing logged.";

    return (
        <div>
            {/* The visual chart is decorative; this carries the data. */}
            <div aria-hidden="true" className="flex items-end justify-between gap-1.5 h-40">
                {days.map((d, i) => (
                    <div key={d.key} className="flex-1 h-full flex flex-col items-center justify-end group">
                        <div className="relative w-full flex items-end justify-center h-full">
                            {d.mood !== null ? (
                                <motion.div
                                    initial={{ height: 0 }}
                                    animate={{ height: `${(d.mood / max) * 100}%` }}
                                    transition={{ delay: i * 0.03, duration: 0.4 }}
                                    className={cn(
                                        "w-full max-w-[24px] rounded-t-lg transition-opacity group-hover:opacity-80",
                                        MOOD_COLORS[d.mood]
                                    )}
                                />
                            ) : (
                                // A day with no entry, drawn as a dashed track.
                                // The previous version drew a 1px grey pill,
                                // which is indistinguishable from nothing at all -
                                // so a week of gaps looked identical to a broken
                                // chart.
                                <div className="w-full max-w-[24px] h-full rounded-t-lg border border-dashed border-gray-200" />
                            )}
                        </div>
                    </div>
                ))}
            </div>
            <div className="flex justify-between mt-2" aria-hidden="true">
                {days.map((d) => (
                    <div key={d.key} className="flex-1 text-center">
                        <p className="text-[10px] font-bold text-gray-500 uppercase">{d.label}</p>
                        <p className="text-[10px] text-gray-400">{d.day}</p>
                    </div>
                ))}
            </div>
            <div className="mt-4 flex items-center justify-center gap-4 flex-wrap" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((m) => (
                    <div key={m} className="flex items-center gap-1.5">
                        <span className={cn("w-2.5 h-2.5 rounded-full", MOOD_COLORS[m])} />
                        <span className="text-[10px] font-semibold text-gray-500">{MOOD_LABELS[m]}</span>
                    </div>
                ))}
            </div>

            {/* The text equivalent of everything above. Visible to a screen
                reader, invisible on screen, and printed by the browser's print
                stylesheet - so the chart is not colour-only information. */}
            <p className="sr-only">{summary}</p>
        </div>
    );
}
