"use client";

import { motion } from "framer-motion";
import { format, addDays, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";

interface DatePickerProps {
    selectedDate: Date | null;
    onChange: (date: Date) => void;
    /** Optional: only these dates are selectable (disabled otherwise). */
    availableDates?: Date[];
}

export default function DatePicker({ selectedDate, onChange, availableDates }: DatePickerProps) {
    // Generate next 14 days
    const dates = Array.from({ length: 14 }).map((_, i) => addDays(new Date(), i));

    const isAvailable = (date: Date) =>
        !availableDates || availableDates.some((d) => isSameDay(d, date));

    return (
        <div className="space-y-4">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">
                Select Consultation Date
            </label>
            <div className="flex gap-3 overflow-x-auto pb-4 scrollbar-hide -mx-1 px-1">
                {dates.map((date, idx) => {
                    const isSelected = selectedDate && isSameDay(date, selectedDate);
                    const isToday = isSameDay(date, new Date());
                    const available = isAvailable(date);

                    return (
                        <motion.button
                            key={idx}
                            whileHover={available ? { y: -2 } : undefined}
                            whileTap={available ? { scale: 0.95 } : undefined}
                            disabled={!available}
                            onClick={() => onChange(date)}
                            className={cn(
                                "relative flex flex-col items-center justify-center min-w-[85px] h-24 rounded-2xl border-2 transition-all p-3",
                                isSelected
                                    ? "bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-200"
                                    : available
                                    ? "bg-white border-gray-50 text-gray-600 hover:border-indigo-100 hover:bg-indigo-50/30"
                                    : "bg-gray-50 border-gray-50 text-gray-300 opacity-60 cursor-not-allowed"
                            )}
                        >
                            {isToday && !isSelected && (
                                <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-indigo-500" />
                            )}
                            <span className={cn(
                                "text-[10px] font-bold uppercase tracking-wider mb-1",
                                isSelected ? "text-indigo-100" : "text-gray-400"
                            )}>
                                {format(date, "EEE")}
                            </span>
                            <span className="text-xl font-bold">{format(date, "dd")}</span>
                            <span className={cn(
                                "text-[10px] font-semibold mt-1",
                                isSelected ? "text-indigo-100" : "text-gray-400"
                            )}>
                                {format(date, "MMM")}
                            </span>

                            {isToday && !isSelected && (
                                <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-indigo-500" />
                            )}
                        </motion.button>
                    );
                })}
            </div>
        </div>
    );
}
