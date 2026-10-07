"use client";

import { useCallback, useEffect, useState } from "react";
import { notFound } from "next/navigation";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import DoctorProfile from "@/components/doctors/DoctorProfile";
import api from "@/lib/api";
import { mapDoctor } from "@/lib/mapDoctor";
import { jsonLdScript } from "@/lib/jsonLd";
import { useAuth } from "@/context/AuthContext";

interface ApiReview {
    id: number;
    rating: number;
    comment: string;
    reply?: string | null;
    repliedAt?: string | null;
    createdAt: string;
    user: { id: number; name: string; avatar?: string };
}

const mapReview = (r: ApiReview) => ({
    id: r.id,
    name: r.user?.name || "Patient",
    avatar: r.user?.avatar,
    rating: r.rating,
    date: new Date(r.createdAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }),
    comment: r.comment,
    reply: r.reply,
    repliedAt: r.repliedAt,
});

export default function DoctorDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { user } = useAuth();
    const [doctor, setDoctor] = useState<any>(null);
    const [reviews, setReviews] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [notFoundState, setNotFoundState] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);

    const load = useCallback(() => {
        setIsLoading(true);
        setLoadFailed(false);
        params
            .then(({ id }) =>
                api.get(`/doctors/${id}`).then((res) => {
                    const data = res.data?.data;
                    if (!data) return { missing: true };
                    setDoctor(mapDoctor(data));
                    setReviews((data.reviews || []).map(mapReview));
                    return { missing: false };
                })
            )
            .then((result) => {
                if (result?.missing) setNotFoundState(true);
            })
            .catch((err: unknown) => {
                console.error("[doctor] profile failed", err);
                const status = (err as { response?: { status?: number } })?.response?.status;
                if (status === 404) setNotFoundState(true);
                else setLoadFailed(true);
            })
            .finally(() => setIsLoading(false));
    }, [params]);

    useEffect(() => {
        load();
    }, [load]);

    if (notFoundState) notFound();

    // Only reached once the request has settled and failed. Without this the
    // guard below stays true forever: `isLoading` is false, `doctor` is null,
    // so `isLoading || !doctor` renders an animated skeleton that never resolves.
    // A 500 on a doctor's public profile looked like a page that had not loaded.
    if (loadFailed) {
        return (
            <main className="min-h-screen bg-white">
                <Navbar />
                <div className="pt-32 px-4 md:px-8 max-w-7xl mx-auto">
                    <div role="alert" className="max-w-md mx-auto text-center border border-rose-200 bg-rose-50 rounded-3xl px-8 py-12">
                        <p className="text-lg font-extrabold text-rose-800 mb-2">Could not load this profile</p>
                        <p className="text-sm text-rose-700 mb-6">
                            The specialist may still be available &mdash; this is a connection problem.
                        </p>
                        <button
                            type="button"
                            onClick={load}
                            className="px-6 py-3 bg-rose-600 text-white rounded-2xl font-bold text-sm hover:bg-rose-700 transition-all"
                        >
                            Try again
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    if (isLoading || !doctor) {
        return (
            <main className="min-h-screen bg-white">
                <Navbar />
                <div className="pt-32 px-4 md:px-8 max-w-7xl mx-auto">
                    <div className="w-40 h-40 rounded-full bg-gray-100 animate-pulse mx-auto md:mx-0" />
                    <div className="h-8 w-64 bg-gray-100 rounded-lg animate-pulse mt-8" />
                    <div className="h-4 w-96 bg-gray-50 rounded animate-pulse mt-4 max-w-full" />
                    <div className="grid md:grid-cols-2 gap-6 mt-12">
                        {[1, 2].map((i) => (
                            <div key={i} className="h-48 bg-gray-50 rounded-3xl animate-pulse" />
                        ))}
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-white">
            <Navbar />
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{
                    // Not a plain `JSON.stringify`: `name` and `specialty` are
                    // clinician-supplied and this renders on the public profile
                    // page, and an unescaped `</script` inside a value would end
                    // the element and hand the rest to the HTML parser.
                    __html: jsonLdScript({
                        "@context": "https://schema.org",
                        "@type": "MedicalBusiness",
                        name: doctor.name,
                        image: doctor.avatar,
                        description: `${doctor.specialty} — ${doctor.experience} years of experience.`,
                        specialty: doctor.specialty,
                        priceRange: `IDR ${doctor.price?.toLocaleString("id-ID")}`,
                        ...(doctor.rating > 0
                            ? {
                                  aggregateRating: {
                                      "@type": "AggregateRating",
                                      ratingValue: doctor.rating,
                                      reviewCount: doctor.reviewCount,
                                  },
                              }
                            : {}),
                        medicalSpecialty: doctor.specialty,
                    }),
                }}
            />
            <DoctorProfile
                doctor={doctor}
                reviews={reviews}
                canReply={user?.role === "doctor" && user.id === doctor.userId}
            />
            <Footer />
        </main>
    );
}
