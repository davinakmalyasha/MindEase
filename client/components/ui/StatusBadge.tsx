"use client";

import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700 border-amber-100",
    confirmed: "bg-emerald-50 text-emerald-700 border-emerald-100",
    completed: "bg-blue-50 text-blue-700 border-blue-100",
    cancelled: "bg-rose-50 text-rose-700 border-rose-100",
};

export default function StatusBadge({ status, className }: { status: string; className?: string }) {
    return (
        <span
            className={cn(
                "inline-flex items-center px-3 py-1 rounded-full text-[11px] font-bold border capitalize",
                STYLES[status.toLowerCase()] || STYLES.pending,
                className
            )}
        >
            <span className="w-1.5 h-1.5 rounded-full bg-current mr-1.5" />
            {status}
        </span>
    );
}
