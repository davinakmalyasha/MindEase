"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

export interface RealSlot {
    id: number;
    startTime: string;
    endTime: string;
    isBooked: boolean;
    date?: Date | null;
}

interface TimeSlotsProps {
    selectedTime: string | null;
    onChange: (time: string) => void;
    slots?: RealSlot[]; // Real availability from the doctor (optional)
    loading?: boolean;
}

const DEFAULT_SLOTS = [
    "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
    "16:00", "16:30", "19:00", "19:30", "20:00", "20:30"
];

export default function TimeSlots({ selectedTime, onChange, slots, loading }: TimeSlotsProps) {
    const available = slots ? slots.filter((s) => !s.isBooked).map((s) => s.startTime) : DEFAULT_SLOTS;
    const hasAvailability = available.length > 0;

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2 mb-2 ml-1">
                <Clock className="w-4 h-4 text-indigo-500" />
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                    {slots ? "Doctor's Available Time Slots" : "Available Time Slots"}
                </label>
                {loading && <span className="w-3 h-3 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />}
            </div>

            {slots && !hasAvailability ? (
                <div className="text-center py-8 bg-gray-50 rounded-2xl">
                    <p className="text-sm font-semibold text-gray-500">No open slots for this day</p>
                    <p className="text-xs text-gray-400 mt-1">Try a different date</p>
                </div>
            ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    {available.map((time) => {
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
            )}

            {slots && (
                <p className="text-[10px] text-gray-400 italic mt-2 ml-1">
                    * Times shown are the doctor&apos;s published slots
                </p>
            )}
        </div>
    );
}
