"use client";

import { motion } from "framer-motion";
import { Doctor } from "@/lib/types/doctor";
import ReviewCard from "@/components/doctors/ReviewCard";
import {
    Star,
    BadgeCheck,
    Briefcase,
    Users,
    Calendar,
    Clock,
    ArrowLeft,
    ShieldCheck,
    DollarSign,
    HeartPulse
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface DoctorProfileProps {
    doctor: Doctor;
    reviews: any[];
}

export default function DoctorProfile({ doctor, reviews }: DoctorProfileProps) {
    const treatments = [
        "Anxiety Disorder",
        "Depression",
        "Stress Management",
        "Personal Development",
        "Work-Life Balance",
        "Relationship Issues"
    ];

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="pt-24 md:pt-32 px-4 md:px-8 max-w-7xl mx-auto"
        >
            <Link
                href="/appointments"
                className="inline-flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold transition-all mb-8 group"
            >
                <div className="p-2 bg-gray-50 rounded-xl group-hover:bg-indigo-50 transition-colors">
                    <ArrowLeft className="w-4 h-4" />
                </div>
                Back to Selection
            </Link>

            <div className="flex flex-col lg:flex-row gap-12 items-start">
                {/* Left Column: Info */}
                <div className="flex-1 w-full">
                    {/* Hero Section */}
                    <section className="flex flex-col md:flex-row gap-8 items-center md:items-start text-center md:text-left mb-12">
                        <motion.div
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ delay: 0.2 }}
                            className="relative w-40 h-40 rounded-full overflow-hidden border-4 border-indigo-50 shadow-2xl shadow-indigo-100 flex-shrink-0"
                        >
                            <Image
                                src={doctor.avatar}
                                alt={doctor.name}
                                fill
                                className="object-cover"
                            />
                        </motion.div>
                        <div className="pt-2">
                            <motion.div
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.3 }}
                                className="flex flex-wrap justify-center md:justify-start items-center gap-3 mb-3"
                            >
                                <span className="px-4 py-1.5 bg-indigo-50 text-indigo-700 rounded-full text-xs font-bold uppercase tracking-widest border border-indigo-100/50">
                                    {doctor.specialty}
                                </span>
                                {doctor.isVerified && (
                                    <span className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-bold border border-emerald-100">
                                        <BadgeCheck className="w-3.5 h-3.5" />
                                        Verified
                                    </span>
                                )}
                                <span className={cn(
                                    "px-4 py-1.5 rounded-full text-xs font-bold border",
                                    doctor.isAvailable
                                        ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                        : "bg-gray-50 text-gray-400 border-gray-100"
                                )}>
                                    {doctor.isAvailable ? "Available" : "Full Booked"}
                                </span>
                            </motion.div>
                            <motion.h1
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.4 }}
                                className="text-3xl md:text-5xl font-extrabold text-gray-900 mb-3 leading-tight"
                            >
                                {doctor.name}
                            </motion.h1>
                            <motion.div
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.5 }}
                                className="flex justify-center md:justify-start items-center gap-2 text-gray-500 font-medium"
                            >
                                <div className="flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded-lg border border-amber-100">
                                    <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                                    <span className="text-amber-700 font-bold">{doctor.rating}</span>
                                </div>
                                <span className="text-gray-300">•</span>
                                <span className="text-sm">({doctor.reviewCount} Reviews)</span>
                            </motion.div>
                        </div>
                    </section>

                    {/* Quick Info Grid */}
                    <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
                        {[
                            { icon: Briefcase, label: "Experience", value: `${doctor.experience} Years`, color: "text-indigo-500" },
                            { icon: Users, label: "Patients", value: "450+", color: "text-purple-500" },
                            { icon: Star, label: "Avg Rating", value: `${doctor.rating} / 5.0`, color: "text-amber-500" }
                        ].map((stat, i) => (
                            <motion.div
                                key={i}
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.6 + (i * 0.1) }}
                                className="p-6 bg-gray-50 rounded-3xl border border-gray-100/50"
                            >
                                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center mb-4 shadow-sm">
                                    <stat.icon className={cn("w-5 h-5", stat.color)} />
                                </div>
                                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">{stat.label}</p>
                                <p className="text-xl font-bold text-gray-900">{stat.value}</p>
                            </motion.div>
                        ))}
                    </section>

                    {/* About Section */}
                    <motion.section
                        initial={{ y: 20, opacity: 0 }}
                        whileInView={{ y: 0, opacity: 1 }}
                        viewport={{ once: true }}
                        className="mb-12"
                    >
                        <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                            <ShieldCheck className="w-7 h-7 text-indigo-500" />
                            About Doctor
                        </h2>
                        <p className="text-gray-600 leading-relaxed text-lg whitespace-pre-line bg-gray-50/50 p-8 rounded-[2.5rem] border border-gray-100">
                            {doctor.bio}
                        </p>
                    </motion.section>

                    {/* Treatment Section */}
                    <motion.section
                        initial={{ y: 20, opacity: 0 }}
                        whileInView={{ y: 0, opacity: 1 }}
                        viewport={{ once: true }}
                        className="mb-12"
                    >
                        <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                            <HeartPulse className="w-7 h-7 text-rose-500" />
                            Specialization & Focus
                        </h2>
                        <div className="flex flex-wrap gap-3">
                            {treatments.map((t, idx) => (
                                <span
                                    key={idx}
                                    className="px-6 py-3 bg-white border border-gray-100 rounded-2xl text-gray-700 font-bold text-sm hover:border-indigo-200 hover:bg-indigo-50/30 transition-all cursor-default"
                                >
                                    {t}
                                </span>
                            ))}
                        </div>
                    </motion.section>

                    {/* Reviews Section */}
                    <section className="mb-20">
                        <div className="flex items-center justify-between mb-8">
                            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                                <Star className="w-7 h-7 text-amber-500" />
                                Latest Reviews
                            </h2>
                            <button className="text-indigo-600 font-bold text-sm hover:underline">
                                See all {doctor.reviewCount} reviews
                            </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {reviews.map((review) => (
                                <ReviewCard key={review.id} review={review} />
                            ))}
                        </div>
                    </section>
                </div>

                {/* Right Column: Booking Card (Desktop Sticky) */}
                <motion.div
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ delay: 0.8 }}
                    className="w-full lg:w-[400px] lg:sticky lg:top-32 mb-12"
                >
                    <div className="bg-white rounded-[2.5rem] border border-gray-100 p-8 shadow-2xl shadow-gray-200/50">
                        <div className="flex items-center justify-between mb-8 pb-8 border-b border-gray-50">
                            <div>
                                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Session Price</p>
                                <p className="text-3xl font-black text-gray-900 flex items-baseline gap-1">
                                    Rp {doctor.price.toLocaleString("id-ID")}
                                    <span className="text-sm font-medium text-gray-400">/hr</span>
                                </p>
                            </div>
                            <div className="p-4 bg-indigo-50 rounded-2xl">
                                <DollarSign className="w-6 h-6 text-indigo-600" />
                            </div>
                        </div>

                        <div className="space-y-4 mb-8">
                            <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-2xl">
                                <Calendar className="w-5 h-5 text-indigo-500" />
                                <span className="text-sm font-bold text-gray-700">{doctor.availability || "Mon - Fri, 09:00 - 17:00"}</span>
                            </div>
                            <p className="text-xs text-center text-gray-400 font-medium">
                                *Jadwal dapat berubah sewaktu-waktu sesuai kebijakan klinik.
                            </p>
                        </div>

                        <Link
                            href="/appointments"
                            className="w-full h-16 flex items-center justify-center gap-3 bg-gray-900 text-white rounded-2xl font-bold text-lg hover:bg-indigo-600 transition-all shadow-xl shadow-gray-200 active:scale-95 text-center"
                        >
                            <Clock className="w-5 h-5" />
                            Book Consultation
                        </Link>
                    </div>
                </motion.div>
            </div>

            {/* Mobile Sticky CTA */}
            <motion.div
                initial={{ y: 100 }}
                animate={{ y: 0 }}
                transition={{ delay: 1 }}
                className="fixed bottom-0 left-0 w-full p-4 bg-white/80 backdrop-blur-md border-t border-gray-100 lg:hidden z-50"
            >
                <Link
                    href="/appointments"
                    className="w-full h-14 flex items-center justify-center bg-gray-900 text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                >
                    Book Now • Rp {doctor.price.toLocaleString("id-ID")}
                </Link>
            </motion.div>
        </motion.div>
    );
}
