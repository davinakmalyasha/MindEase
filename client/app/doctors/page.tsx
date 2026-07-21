"use client";

import { Suspense, useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { DOCTORS as FALLBACK, ITEMS_PER_PAGE } from "@/lib/data/doctors";
import { Specialty } from "@/lib/types/doctor";
import FilterSidebar from "@/components/doctors/FilterSidebar";
import DoctorGrid from "@/components/doctors/DoctorGrid";
import Navbar from "@/components/layout/Navbar";
import api from "@/lib/api";

interface ApiDoctor {
    id: number;
    specialty: string;
    bio: string;
    experience: number;
    rating: number;
    price: number;
    availability: string;
    user: { name?: string; avatar?: string; phone_number?: string };
    reviews?: any[];
}

const mapDoctor = (d: ApiDoctor): any => ({
    id: d.id,
    name: d.user?.name || "Doctor",
    specialty: d.specialty,
    avatar: d.user?.avatar || "",
    image: d.user?.avatar || "",
    rating: d.rating || 0,
    reviewCount: d.reviews?.length || 0,
    experience: d.experience || 0,
    isAvailable: d.availability === "Available",
    isVerified: true,
    bio: d.bio || "",
    price: d.price || 0,
    availability: d.availability,
});

function DoctorsContent() {
    const searchParams = useSearchParams();
    const [doctors, setDoctors] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [useFallback, setUseFallback] = useState(false);

    useEffect(() => {
        let active = true;
        api.get("/doctors")
            .then((res) => {
                if (!active) return;
                const data = Array.isArray(res.data?.data) ? res.data.data : [];
                if (data.length === 0) {
                    setUseFallback(true);
                    setDoctors(FALLBACK);
                } else {
                    setDoctors(data.map(mapDoctor));
                }
            })
            .catch(() => {
                if (!active) return;
                setUseFallback(true);
                setDoctors(FALLBACK);
            })
            .finally(() => active && setIsLoading(false));
        return () => {
            active = false;
        };
    }, []);

    const filtered = useMemo(() => {
        const search = searchParams.get("search")?.toLowerCase() ?? "";
        const specialty = (searchParams.get("specialty") as Specialty) ?? "All";
        const minExperience = Number(searchParams.get("exp")) || 0;
        const availableOnly = searchParams.get("available") === "true";

        return doctors.filter((d) => {
            if (search && !d.name.toLowerCase().includes(search) && !d.specialty.toLowerCase().includes(search) && !d.bio.toLowerCase().includes(search)) return false;
            if (specialty !== "All" && d.specialty !== specialty) return false;
            if (minExperience > 0 && d.experience < minExperience) return false;
            if (availableOnly && !d.isAvailable) return false;
            return true;
        });
    }, [doctors, searchParams]);

    const page = Number(searchParams.get("page")) || 1;
    const start = (page - 1) * ITEMS_PER_PAGE;
    const paginated = filtered.slice(start, start + ITEMS_PER_PAGE);

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
                        {useFallback && <span className="text-amber-500 italic"> (offline preview data)</span>}
                    </p>
                </div>

                <div className="flex flex-col lg:flex-row gap-8">
                    <FilterSidebar />
                    <DoctorGrid doctors={paginated} totalCount={filtered.length} />
                </div>
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
