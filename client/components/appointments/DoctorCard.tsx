"use client";

import { Doctor } from "@/lib/types/doctor";
import { Star, Clock, Briefcase, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
import NextImage from "next/image";
import Link from "next/link";

interface DoctorCardProps {
    doctor: Doctor;
    onSelect: (doctor: Doctor) => void;
}

export default function DoctorCard({ doctor, onSelect }: DoctorCardProps) {
    return (
        <motion.div
            whileHover={{ y: -5 }}
            className="group bg-white rounded-3xl border border-gray-100 p-6 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 transition-all duration-300"
        >
            <div className="flex flex-col md:flex-row gap-6">
                {/* Avatar */}
                <div className="relative w-full md:w-32 aspect-square rounded-2xl overflow-hidden bg-indigo-50 border border-indigo-100">
                    <NextImage
                        src={doctor.image || "/doctor-placeholder.jpg"}
                        alt={doctor.name}
                        fill
                        className="object-cover group-hover:scale-110 transition-transform duration-500"
                    />
                </div>

                {/* Content */}
                <div className="flex-1 flex flex-col justify-between">
                    <div>
                        <div className="flex justify-between items-start mb-2">
                            <Link href={`/doctors/${doctor.id}`}>
                                <h3 className="text-xl font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">
                                    {doctor.name}
                                </h3>
                                <p className="text-indigo-600 font-semibold text-sm uppercase tracking-wider mb-2">
                                    {doctor.specialty}
                                </p>
                            </Link>
                            <div className="flex items-center gap-1 bg-amber-50 px-2 py-1 rounded-lg">
                                <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                                <span className="text-sm font-bold text-amber-700">{doctor.rating}</span>
                            </div>
                        </div>
                        <Link href={`/doctors/${doctor.id}`}>
                            <p className="text-gray-500 text-sm line-clamp-2 mb-4 leading-relaxed cursor-pointer hover:text-indigo-500 transition-colors">
                                {doctor.bio}
                            </p>
                        </Link>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-sm text-gray-400">
                        <div className="flex items-center gap-1.5 shadow-sm px-3 py-1.5 rounded-full bg-gray-50">
                            <Briefcase className="w-4 h-4 text-gray-500" />
                            <span className="font-medium text-gray-600">{doctor.experience} Years Exp</span>
                        </div>
                        <div className="flex items-center gap-1.5 shadow-sm px-3 py-1.5 rounded-full bg-gray-50">
                            <Clock className="w-4 h-4 text-gray-500" />
                            <span className="font-medium text-gray-600">{doctor.availability || "Mon - Fri"}</span>
                        </div>
                    </div>
                </div>

                {/* Action */}
                <div className="flex md:flex-col justify-between items-center md:items-end border-t md:border-t-0 md:border-l border-gray-100 pt-4 md:pt-0 md:pl-6 gap-4">
                    <div className="text-right">
                        <p className="text-xs text-gray-400 font-medium uppercase tracking-widest">Fees</p>
                        <p className="text-xl font-bold text-gray-900">Rp {doctor.price.toLocaleString("id-ID")}</p>
                    </div>
                    <div className="flex flex-col gap-2 w-full">
                        <button
                            onClick={() => onSelect(doctor)}
                            className="flex items-center justify-center gap-2 bg-indigo-600 text-white rounded-2xl px-6 py-3 font-bold hover:bg-indigo-700 active:scale-95 transition-all shadow-lg shadow-indigo-100 w-full"
                        >
                            Book Now
                            <ChevronRight className="w-4 h-4" />
                        </button>
                        <Link
                            href={`/doctors/${doctor.id}`}
                            className="flex items-center justify-center gap-2 bg-gray-50 text-gray-600 rounded-2xl px-6 py-2.5 text-sm font-bold hover:bg-gray-100 transition-all w-full"
                        >
                            View Profile
                        </Link>
                    </div>
                </div>
            </div>
        </motion.div>
    );
}
