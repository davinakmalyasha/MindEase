"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTransition } from "react";
import { Doctor } from "@/lib/types/doctor";
import DoctorCard from "./DoctorCard";
import { SearchX } from "lucide-react";

interface DoctorGridProps {
    doctors: Doctor[];
    totalCount: number;
}

export default function DoctorGrid({ doctors, totalCount }: DoctorGridProps) {
    const router = useRouter();
    const pathname = usePathname();
    const [isPending, startTransition] = useTransition();

    // Pagination lives in the directory page as Load More: this grid renders
    // whatever has arrived so far and never numbers pages itself.
    const clearFilters = () => {
        startTransition(() => {
            router.replace(pathname, { scroll: false });
        });
    };

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
        </div>
    );
}
