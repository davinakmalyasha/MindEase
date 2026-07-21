"use client";

import { User } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Avatar({
    src,
    name,
    size = "md",
    className,
}: {
    src?: string | null;
    name?: string | null;
    size?: "sm" | "md" | "lg";
    className?: string;
}) {
    const sizes = {
        sm: "w-8 h-8 text-xs",
        md: "w-12 h-12 text-sm",
        lg: "w-20 h-20 text-2xl",
    };

    const initial = name?.trim()?.charAt(0)?.toUpperCase() || "?";

    return (
        <div
            className={cn(
                "rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center overflow-hidden shrink-0 text-indigo-400 font-bold",
                sizes[size],
                className
            )}
        >
            {src ? (
                <img src={src} alt={name || "avatar"} className="w-full h-full object-cover" />
            ) : name ? (
                initial
            ) : (
                <User className={size === "lg" ? "w-10 h-10" : "w-4 h-4"} />
            )}
        </div>
    );
}
