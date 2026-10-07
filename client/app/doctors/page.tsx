"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Star, Sparkles, Loader2 } from "lucide-react";
import FilterSidebar from "@/components/doctors/FilterSidebar";
import DoctorGrid from "@/components/doctors/DoctorGrid";
import Navbar from "@/components/layout/Navbar";
import AiSourceBadge from "@/components/ui/AiSourceBadge";
import api from "@/lib/api";
import { mapDoctor, type ApiDoctor } from "@/lib/mapDoctor";

const PRICE_RANGES: Record<string, { min?: number; max?: number }> = {
    under100: { max: 100000 },
    mid: { min: 100000, max: 300000 },
    over300: { min: 300000 },
};

function DoctorsContent() {
    const searchParams = useSearchParams();
    const [doctors, setDoctors] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    // Distinct from `loadError`: the first page failed, so there is nothing to
    // show. A later page failed, so there is a list to show and it is short.
    const [pageError, setPageError] = useState(false);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [total, setTotal] = useState(0);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [aiQuery, setAiQuery] = useState("");
    const [aiMatches, setAiMatches] = useState<any[] | null>(null);
    const [aiFailed, setAiFailed] = useState(false);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiCriteria, setAiCriteria] = useState<string>("");
    const [aiSource, setAiSource] = useState<"model" | "fallback" | undefined>(undefined);

    // Filters live in the URL and are applied SERVER-SIDE (search, specialty,
    // price preset, experience, availability, sort) so pagination is correct.
    const filterKey = searchParams.toString();

    const buildQuery = (targetPage: number) => {
        const params = new URLSearchParams();
        params.set("page", String(targetPage));
        params.set("limit", "20");
        const search = searchParams.get("search")?.trim();
        const specialty = searchParams.get("specialty");
        const exp = Number(searchParams.get("exp")) || 0;
        const preset = PRICE_RANGES[searchParams.get("price") || ""] || {};
        if (search) params.set("q", search);
        if (specialty && specialty !== "All") params.set("specialty", specialty);
        if (exp > 0) params.set("minExperience", String(exp));
        if (preset.min !== undefined) params.set("priceMin", String(preset.min));
        if (preset.max !== undefined) params.set("priceMax", String(preset.max));
        if (searchParams.get("available") === "true") params.set("availableOnly", "true");
        const sort = searchParams.get("sort");
        if (sort) params.set("sort", sort);
        return params.toString();
    };

    /**
     * Loads one page.
     *
     * Returns whether it succeeded, because the caller advances a page counter
     * and that counter must not move on a failure. `loadMore` used to do
     * `await loadPage(page + 1); setPage((p) => p + 1)` regardless, so one failed
     * request advanced the cursor past a page that was never received: the next
     * click asked for page 3, and the specialists on page 2 became unreachable
     * for the rest of the session. Silent, permanent, and not retryable.
     */
    const loadPage = async (targetPage: number): Promise<boolean> => {
        try {
            const res = await api.get(`/doctors?${buildQuery(targetPage)}`);
            const data = res.data?.data;
            const rows = Array.isArray(data) ? data : data?.rows || [];
            const pages = Array.isArray(data) ? 1 : data?.totalPages || 1;
            setTotalPages(pages);
            setTotal(Array.isArray(data) ? rows.length : data?.total ?? rows.length);
            if (rows.length > 0) {
                setDoctors((prev) => (targetPage === 1 ? rows.map(mapDoctor) : [...prev, ...rows.map(mapDoctor)]));
            }
            return true;
        } catch (err) {
            console.error("[doctors] page failed", err);
            setPageError(true);
            return false;
        }
    };

    const fetchDoctors = async () => {
        setIsLoading(true);
        setLoadError(false);
        setPageError(false);
        try {
            const res = await api.get(`/doctors?${buildQuery(1)}`);
            const data = res.data?.data;
            const rows = Array.isArray(data) ? data : data?.rows || [];
            const pages = Array.isArray(data) ? 1 : data?.totalPages || 1;
            setTotalPages(pages);
            setTotal(Array.isArray(data) ? rows.length : data?.total ?? rows.length);
            setDoctors(rows.map(mapDoctor));
        } catch {
            setLoadError(true);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        let active = true;
        setPage(1);
        (async () => {
            await fetchDoctors();
            if (!active) return;
        })();
        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterKey]);

    const loadMore = async () => {
        if (isLoadingMore || page >= totalPages) return;
        setIsLoadingMore(true);
        setPageError(false);
        const next = page + 1;
        // Advance only on success, so a failed page stays the next page to ask
        // for rather than being skipped past.
        if (await loadPage(next)) setPage(next);
        setIsLoadingMore(false);
    };

    const askAI = async () => {
        const query = aiQuery.trim();
        if (query.length < 3 || aiLoading) return;
        setAiLoading(true);
        setAiMatches(null);
        setAiFailed(false);
        try {
            const res = await api.post("/ai/match-doctors", { query });
            const data = res.data?.data;
            setAiMatches(data?.doctors || []);
            setAiSource(data?.ai?.source);
            const c = data?.criteria;
            setAiCriteria(
                [c?.specialty ? `specialty: ${c.specialty}` : "", c?.maxPrice ? `max price: Rp ${c.maxPrice.toLocaleString("id-ID")}` : "", c?.minExperience ? `min ${c.minExperience} yrs` : ""]
                    .filter(Boolean)
                    .join(" · ")
            );
        } catch (err) {
            // An empty array here would have said "No specialists matched your
            // description" - a confident claim about the practice's roster,
            // produced by a connection failure. Ask again instead.
            console.error("[doctors] ai match failed", err);
            setAiFailed(true);
            setAiMatches(null);
        } finally {
            setAiLoading(false);
        }
    };

    if (isLoading) {
        return (
            <>
                <Navbar />
                <main className="min-h-screen bg-gray-50 pt-24 pb-16 px-[5%]">
                    <div className="h-8 w-64 bg-gray-200 rounded-lg animate-pulse mb-8" />
                    <div className="flex flex-col lg:flex-row gap-8">
                        <div className="w-full lg:w-72 h-96 bg-gray-200 rounded-2xl animate-pulse" />
                        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                            {Array.from({ length: 8 }).map((_, i) => (
                                <div key={i} className="h-80 bg-gray-200 rounded-3xl animate-pulse" />
                            ))}
                        </div>
                    </div>
                </main>
            </>
        );
    }

    return (
        <>
            <Navbar />
            <main className="min-h-screen bg-gray-50 pt-24 pb-16 px-[5%]">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-900">Find Your Doctor</h1>
                    <p className="text-gray-500 mt-1">
                        Browse our certified mental health professionals
                    </p>
                </div>

                {loadError && (
                    <div className="bg-white rounded-3xl border border-rose-100 shadow-lg shadow-rose-500/5 p-8 mb-8 text-center">
                        <p className="text-sm font-bold text-gray-900 mb-1">We couldn&apos;t load the doctor directory</p>
                        <p className="text-xs text-gray-400 mb-4">Please check your connection and try again.</p>
                        <button
                            onClick={fetchDoctors}
                            className="px-6 py-2.5 bg-indigo-600 text-white rounded-2xl text-sm font-black hover:bg-indigo-700 transition-all"
                        >
                            Retry
                        </button>
                    </div>
                )}

                {/* AI matching */}
                <div className="bg-white rounded-3xl border border-indigo-100 shadow-lg shadow-indigo-500/5 p-5 mb-8">
                    <p className="text-xs font-bold text-indigo-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" /> Ask AI to match you
                    </p>
                    <div className="flex gap-2">
                        <input
                            value={aiQuery}
                            onChange={(e) => setAiQuery(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && askAI()}
                            placeholder="e.g. I feel anxious about work and want affordable sessions this week"
                            className="flex-1 px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                        <button
                            onClick={askAI}
                            disabled={aiLoading || aiQuery.trim().length < 3}
                            className="px-6 py-3 bg-indigo-600 text-white rounded-2xl text-sm font-black hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                            {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                            Match
                        </button>
                    </div>
                    {aiFailed && (
                        <div role="alert" className="mt-4 pt-4 border-t border-gray-100 text-center">
                            <p className="text-sm text-rose-700 mb-3">
                                The AI match did not come back. Nothing about the directory has changed.
                            </p>
                            <button
                                type="button"
                                onClick={askAI}
                                className="px-5 py-2 border border-rose-200 bg-white text-rose-700 rounded-2xl text-xs font-black hover:bg-rose-50 transition-all"
                            >
                                Ask again
                            </button>
                        </div>
                    )}
                    {aiMatches && (
                        <div className="mt-4 pt-4 border-t border-gray-100">
                            <div className="flex items-center justify-between mb-3">
                                <p className="text-sm font-black text-gray-900">AI recommended {aiMatches.length} specialist{aiMatches.length === 1 ? "" : "s"}</p>
                                <AiSourceBadge source={aiSource} />
                            </div>
                            {aiCriteria && <p className="text-[11px] text-gray-400 font-medium">{aiCriteria}</p>}
                            {aiMatches.length === 0 ? (
                                <p className="text-sm text-gray-400 py-4 text-center">No specialists matched your description. Try browsing manually below.</p>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                    {aiMatches.map((m) => (
                                        <Link
                                            key={m.id}
                                            href={`/doctors/${m.id}`}
                                            className="flex items-center gap-3 p-3.5 bg-indigo-50/50 border border-indigo-100 rounded-2xl hover:bg-indigo-50 transition-colors"
                                        >
                                            <div className="relative w-12 h-12 rounded-2xl overflow-hidden bg-indigo-100 flex-shrink-0">
                                                {m.avatar ? (
                                                    <img src={m.avatar} alt={m.name} className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center font-black text-indigo-500">
                                                        {m.name?.charAt(0)}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-black text-gray-900 truncate">{m.name}</p>
                                                <p className="text-[11px] text-gray-500 font-medium truncate">{m.specialty} · {m.experience} yrs · Rp {m.price?.toLocaleString("id-ID")}</p>
                                                <p className="text-[11px] text-indigo-500 font-bold flex items-center gap-1">
                                                    <Star className="w-3 h-3 text-amber-400 fill-amber-400" /> {m.rating}
                                                    <span className="text-gray-300 font-medium">·</span> Why: {(m.matchReasons || []).join(", ") || "top rated"}
                                                </p>
                                            </div>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {!loadError && (
                    <div className="flex flex-col lg:flex-row gap-8">
                        <FilterSidebar />
                        <div className="flex-1">
                            <DoctorGrid doctors={doctors} totalCount={total} />
                            {pageError ? (
                                // The list is real and short. Saying "could not load the
                                // directory" here would be as wrong as the original
                                // silent skip, and hiding it entirely left the user
                                // with no way to know results were missing.
                                <div role="alert" className="mt-10 text-center border border-rose-200 bg-rose-50 rounded-3xl px-6 py-8">
                                    <p className="text-sm font-bold text-rose-800 mb-1">
                                        Could not load the next page
                                    </p>
                                    <p className="text-xs text-rose-700 mb-4">
                                        The {doctors.length} specialists above are complete. The rest have not
                                        arrived yet.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={loadMore}
                                        className="px-6 py-2.5 bg-rose-600 text-white rounded-2xl text-sm font-black hover:bg-rose-700 transition-all"
                                    >
                                        Try again
                                    </button>
                                </div>
                            ) : page < totalPages ? (
                                <div className="mt-10 text-center">
                                    <button
                                        onClick={loadMore}
                                        disabled={isLoadingMore}
                                        className="px-8 py-3.5 bg-white border-2 border-indigo-100 text-indigo-600 rounded-2xl font-black hover:bg-indigo-50 transition-all disabled:opacity-50"
                                    >
                                        {isLoadingMore ? "Loading…" : "Load more doctors"}
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    </div>
                )}
            </main>
        </>
    );
}

export default function DoctorsPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
            <DoctorsContent />
        </Suspense>
    );
}
