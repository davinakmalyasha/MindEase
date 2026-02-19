import { Suspense } from "react";
import { DOCTORS, ITEMS_PER_PAGE } from "@/lib/data/doctors";
import { Specialty } from "@/lib/types/doctor";
import FilterSidebar from "@/components/doctors/FilterSidebar";
import DoctorGrid from "@/components/doctors/DoctorGrid";
import DoctorCardSkeleton from "@/components/doctors/DoctorCardSkeleton";
import Navbar from "@/components/layout/Navbar";

interface PageProps {
    searchParams: Promise<{
        search?: string;
        specialty?: string;
        exp?: string;
        available?: string;
        page?: string;
    }>;
}

export default async function DoctorsPage({ searchParams }: PageProps) {
    const params = await searchParams;

    const search = params.search?.toLowerCase() ?? "";
    const specialty = (params.specialty as Specialty) ?? "All";
    const minExperience = Number(params.exp) || 0;
    const availableOnly = params.available === "true";
    const page = Number(params.page) || 1;

    let filtered = DOCTORS;

    if (search) {
        filtered = filtered.filter(
            (d) =>
                d.name.toLowerCase().includes(search) ||
                d.specialty.toLowerCase().includes(search) ||
                d.bio.toLowerCase().includes(search)
        );
    }

    if (specialty !== "All") {
        filtered = filtered.filter((d) => d.specialty === specialty);
    }

    if (minExperience > 0) {
        filtered = filtered.filter((d) => d.experience >= minExperience);
    }

    if (availableOnly) {
        filtered = filtered.filter((d) => d.isAvailable);
    }

    const totalCount = filtered.length;
    const start = (page - 1) * ITEMS_PER_PAGE;
    const paginated = filtered.slice(start, start + ITEMS_PER_PAGE);

    return (
        <>
            <Navbar />
            <main className="min-h-screen bg-gray-50 pt-24 pb-16 px-[5%]">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-900">Find Your Doctor</h1>
                    <p className="text-gray-500 mt-1">Browse our certified mental health professionals</p>
                </div>

                <div className="flex flex-col lg:flex-row gap-8">
                    <Suspense fallback={<div className="w-full lg:w-72 h-96 bg-gray-200 rounded-2xl animate-pulse" />}>
                        <FilterSidebar />
                    </Suspense>

                    <Suspense
                        fallback={
                            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                                {Array.from({ length: 8 }).map((_, i) => (
                                    <DoctorCardSkeleton key={i} />
                                ))}
                            </div>
                        }
                    >
                        <DoctorGrid doctors={paginated} totalCount={totalCount} />
                    </Suspense>
                </div>
            </main>
        </>
    );
}
