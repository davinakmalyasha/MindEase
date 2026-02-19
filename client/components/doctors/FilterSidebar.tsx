"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useTransition } from "react";
import { SPECIALTIES, Specialty } from "@/lib/types/doctor";
import { Search, X } from "lucide-react";

export default function FilterSidebar() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const [isPending, startTransition] = useTransition();

    const search = searchParams.get("search") ?? "";
    const specialty = (searchParams.get("specialty") as Specialty) ?? "All";
    const minExperience = Number(searchParams.get("exp")) || 0;
    const availableOnly = searchParams.get("available") === "true";

    const updateParams = useCallback(
        (updates: Record<string, string>) => {
            const params = new URLSearchParams(searchParams.toString());

            Object.entries(updates).forEach(([key, value]) => {
                if (!value || value === "All" || value === "0" || value === "false") {
                    params.delete(key);
                } else {
                    params.set(key, value);
                }
            });

            params.delete("page");

            startTransition(() => {
                router.replace(`${pathname}?${params.toString()}`, { scroll: false });
            });
        },
        [searchParams, router, pathname]
    );

    const clearFilters = useCallback(() => {
        startTransition(() => {
            router.replace(pathname, { scroll: false });
        });
    }, [router, pathname]);

    const hasActiveFilters = search || specialty !== "All" || minExperience > 0 || availableOnly;

    return (
        <aside className={`w-full lg:w-72 shrink-0 space-y-6 ${isPending ? "opacity-70" : ""} transition-opacity`}>
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-gray-900">Filters</h2>
                {hasActiveFilters && (
                    <button
                        onClick={clearFilters}
                        className="text-xs text-indigo-600 font-medium hover:underline flex items-center gap-1"
                    >
                        <X className="w-3 h-3" /> Clear all
                    </button>
                )}
            </div>

            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                    type="text"
                    placeholder="Search doctors..."
                    value={search}
                    onChange={(e) => updateParams({ search: e.target.value })}
                    className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all"
                />
            </div>

            <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Specialty</label>
                <div className="flex flex-wrap gap-2">
                    {SPECIALTIES.map((s) => (
                        <button
                            key={s}
                            onClick={() => updateParams({ specialty: s })}
                            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${specialty === s
                                    ? "bg-indigo-600 text-white border-indigo-600"
                                    : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600"
                                }`}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min. Experience: <span className="text-indigo-600 font-bold">{minExperience}+ years</span>
                </label>
                <input
                    type="range"
                    min={0}
                    max={20}
                    step={1}
                    value={minExperience}
                    onChange={(e) => updateParams({ exp: e.target.value })}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>0</span>
                    <span>20+</span>
                </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                <span className="text-sm font-medium text-gray-700">Available only</span>
                <button
                    onClick={() => updateParams({ available: availableOnly ? "false" : "true" })}
                    className={`relative w-11 h-6 rounded-full transition-colors ${availableOnly ? "bg-indigo-600" : "bg-gray-300"}`}
                >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${availableOnly ? "translate-x-5" : "translate-x-0"}`} />
                </button>
            </div>
        </aside>
    );
}
