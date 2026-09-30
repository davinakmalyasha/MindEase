"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import DoctorProfile from "@/components/doctors/DoctorProfile";
import api from "@/lib/api";
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

const mapDoctor = (d: any) => ({
    id: d.id,
    userId: d.user?.id,
    name: d.user?.name || "Doctor",
    specialty: d.specialty,
    avatar: d.user?.avatar || "",
    image: d.user?.avatar || "",
    rating: d.rating || 0,
    reviewCount: d.reviews?.length || 0,
    experience: d.experience || 0,
    isAvailable: d.availability === "Available",
    isVerified: d.verificationStatus === "approved",
    bio: d.bio || "",
    price: d.price || 0,
    availability: d.availability,
    consultationSlots: d.consultationSlots || [],
});

export default function DoctorDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { user } = useAuth();
    const [doctor, setDoctor] = useState<any>(null);
    const [reviews, setReviews] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [notFoundState, setNotFoundState] = useState(false);

    useEffect(() => {
        let active = true;
        params.then(({ id }) => {
            api.get(`/doctors/${id}`)
                .then((res) => {
                    if (!active) return;
                    const data = res.data?.data;
                    if (!data) return setNotFoundState(true);
                    setDoctor(mapDoctor(data));
                    setReviews((data.reviews || []).map(mapReview));
                })
                .catch((err) => {
                    if (!active) return;
                    if (err?.response?.status === 404) setNotFoundState(true);
                })
                .finally(() => active && setIsLoading(false));
        });
        return () => {
            active = false;
        };
    }, [params]);

    if (notFoundState) notFound();

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
