import Image from "next/image";
import { Doctor } from "@/lib/types/doctor";
import { Star, BadgeCheck, Clock, ChevronRight } from "lucide-react";
import Link from "next/link";

interface DoctorCardProps {
    doctor: Doctor;
}

export default function DoctorCard({ doctor }: DoctorCardProps) {
    return (
        <div className="group bg-white rounded-2xl border border-gray-100 p-5 hover:shadow-xl hover:shadow-indigo-500/10 hover:border-indigo-100 transition-all duration-300 flex flex-col h-full">
            <Link href={`/doctors/${doctor.id}`} className="flex items-start gap-4 mb-4 cursor-pointer">
                <div className="relative w-14 h-14 rounded-full overflow-hidden ring-2 ring-gray-100 group-hover:ring-indigo-200 transition-all shrink-0">
                    <Image
                        src={doctor.avatar}
                        alt={doctor.name}
                        fill
                        className="object-cover"
                    />
                </div>
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                        <h3 className="font-semibold text-gray-900 truncate group-hover:text-indigo-600 transition-colors">{doctor.name}</h3>
                        {doctor.isVerified && (
                            <BadgeCheck className="w-4 h-4 text-indigo-600 shrink-0" />
                        )}
                    </div>
                    <p className="text-sm text-indigo-600 font-medium">{doctor.specialty}</p>
                    <div className="flex items-center gap-1 mt-1">
                        <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                        <span className="text-sm font-semibold text-gray-900">{doctor.rating}</span>
                        <span className="text-xs text-gray-400">({doctor.reviewCount})</span>
                    </div>
                </div>
            </Link>

            <p className="text-sm text-gray-500 leading-relaxed mb-4 line-clamp-2">{doctor.bio}</p>

            <div className="mt-auto">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-1.5 text-sm text-gray-500">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{doctor.experience}y exp</span>
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${doctor.isAvailable ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {doctor.isAvailable ? "Available" : "Unavailable"}
                    </span>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-gray-50">
                    <p className="text-lg font-bold text-gray-900">
                        Rp {doctor.price.toLocaleString("id-ID")}<span className="text-xs font-normal text-gray-400">/session</span>
                    </p>
                    <Link
                        href={`/doctors/${doctor.id}`}
                        className="px-5 py-2 text-sm font-semibold rounded-full bg-indigo-600 text-white hover:bg-indigo-700 transition-all active:scale-95 flex items-center gap-1 group/btn"
                    >
                        Profile
                        <ChevronRight className="w-3.5 h-3.5 group-hover/btn:translate-x-0.5 transition-transform" />
                    </Link>
                </div>
            </div>
        </div>
    );
}
