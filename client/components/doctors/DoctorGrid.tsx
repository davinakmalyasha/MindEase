"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useTransition, Suspense } from "react";
import { Doctor } from "@/lib/types/doctor";
import DoctorCard from "./DoctorCard";
import DoctorCardSkeleton from "./DoctorCardSkeleton";
import { ITEMS_PER_PAGE } from "@/lib/data/doctors";
import { SearchX, ChevronLeft, ChevronRight } from "lucide-react";

interface DoctorGridProps {
    doctors: Doctor[];
    totalCount: number;
}

export default function DoctorGrid({ doctors, totalCount }: DoctorGridProps) {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const [isPending, startTransition] = useTransition();

    const currentPage = Number(searchParams.get("page")) || 1;
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

    const setPage = useCallback(
        (page: number) => {
            const params = new URLSearchParams(searchParams.toString());
            if (page <= 1) {
                params.delete("page");
            } else {
                params.set("page", String(page));
            }
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

    if (doctors.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
                <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center mb-6">
                    <SearchX className="w-10 h-10 text-gray-400" />
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">No Doctors Found</h3>
                <p className="text-gray-500 mb-6 max-w-sm">We couldn&apos;t find any doctors matching your filters. Try adjusting your search criteria.</p>
                <button
                    onClick={clearFilters}
                    className="px-6 py-2.5 text-sm font-semibold rounded-full bg-indigo-600 text-white hover:bg-indigo-700 transition-colors active:scale-95"
                >
                    Clear All Filters
                </button>
            </div>
        );
    }

    return (
        <div className={`flex-1 ${isPending ? "opacity-70" : ""} transition-opacity`}>
            <div className="flex items-center justify-between mb-6">
                <p className="text-sm text-gray-500">
                    Showing <span className="font-semibold text-gray-900">{doctors.length}</span> of{" "}
                    <span className="font-semibold text-gray-900">{totalCount}</span> doctors
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                {doctors.map((doctor) => (
                    <DoctorCard key={doctor.id} doctor={doctor} />
                ))}
            </div>

            {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-10">
                    <button
                        disabled={currentPage <= 1}
                        onClick={() => setPage(currentPage - 1)}
                        className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>

                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                        <button
                            key={page}
                            onClick={() => setPage(page)}
                            className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${page === currentPage
                                    ? "bg-indigo-600 text-white"
                                    : "text-gray-600 hover:bg-gray-100"
                                }`}
                        >
                            {page}
                        </button>
                    ))}

                    <button
                        disabled={currentPage >= totalPages}
                        onClick={() => setPage(currentPage + 1)}
                        className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
