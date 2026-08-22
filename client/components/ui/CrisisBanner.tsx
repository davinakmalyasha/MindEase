import Link from "next/link";
import { HeartHandshake } from "lucide-react";

export default function CrisisBanner() {
    return (
        <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-2xl px-4 py-3 mb-6 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
                <HeartHandshake className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" />
                <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">
                    Feeling unsafe or in crisis? Get free, confidential help right now.
                </p>
            </div>
            <Link
                href="/crisis"
                className="text-sm font-black text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 underline underline-offset-4 shrink-0"
            >
                View hotlines →
            </Link>
        </div>
    );
}
