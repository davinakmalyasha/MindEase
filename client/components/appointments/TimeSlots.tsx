"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

interface TimeSlotsProps {
    selectedTime: string | null;
    onChange: (time: string) => void;
}

export default function TimeSlots({ selectedTime, onChange }: TimeSlotsProps) {
    const slots = [
        "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
        "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
        "16:00", "16:30", "19:00", "19:30", "20:00", "20:30"
    ];

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2 mb-2 ml-1">
                <Clock className="w-4 h-4 text-indigo-500" />
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                    Available Time Slots
                </label>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {slots.map((time) => {
                    const isSelected = selectedTime === time;

                    return (
                        <motion.button
                            key={time}
                            whileHover={{ y: -2 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={() => onChange(time)}
                            className={cn(
                                "py-3 rounded-2xl border-2 transition-all font-bold text-sm",
                                isSelected
                                    ? "bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100"
                                    : "bg-white border-gray-50 text-gray-600 hover:border-indigo-100 hover:bg-indigo-50/30"
                            )}
                        >
                            {time}
                        </motion.button>
                    );
                })}
            </div>

            <p className="text-[10px] text-gray-400 italic mt-2 ml-1">
                * All times are in your local timezone (GMT+7)
            </p>
        </div>
    );
}
