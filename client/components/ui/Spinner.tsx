"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Spinner({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "lg" }) {
    const sizes = { sm: "w-4 h-4", md: "w-6 h-6", lg: "w-10 h-10" };
    return <Loader2 className={cn("animate-spin text-indigo-600", sizes[size], className)} />;
}
