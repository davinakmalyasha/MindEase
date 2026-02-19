"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type Status = 'all' | 'pending' | 'confirmed' | 'completed' | 'cancelled';

interface AppointmentFiltersProps {
    activeStatus: Status;
    onStatusChange: (status: Status) => void;
}

export default function AppointmentFilters({ activeStatus, onStatusChange }: AppointmentFiltersProps) {
    const statuses: { label: string; value: Status }[] = [
        { label: "All", value: "all" },
        { label: "Pending", value: "pending" },
        { label: "Confirmed", value: "confirmed" },
        { label: "Completed", value: "completed" },
        { label: "Cancelled", value: "cancelled" },
    ];

    return (
        <div className="flex flex-wrap gap-2 p-1.5 bg-gray-50 rounded-2xl border border-gray-100 self-start">
            {statuses.map((s) => (
                <button
                    key={s.value}
                    onClick={() => onStatusChange(s.value)}
                    className={cn(
                        "relative px-6 py-2.5 rounded-xl text-sm font-bold transition-all duration-300",
                        activeStatus === s.value
                            ? "text-white"
                            : "text-gray-500 hover:text-gray-900 hover:bg-white/50"
                    )}
                >
                    {activeStatus === s.value && (
                        <motion.div
                            layoutId="active-tab"
                            className="absolute inset-0 bg-indigo-600 rounded-xl -z-10"
                            transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                        />
                    )}
                    {s.label}
                </button>
            ))}
        </div>
    );
}
