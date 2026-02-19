"use client";

import { motion } from "framer-motion";
import { format } from "date-fns";
import { Doctor } from "@/lib/types/doctor";
import { Calendar, Clock, Video, User, CheckCircle2 } from "lucide-react";
import Image from "next/image";

interface BookingSummaryProps {
    doctor: Doctor;
    date: Date;
    time: string;
    patientInfo: {
        name: string;
        type: string;
        notes: string;
    };
}

export default function BookingSummary({ doctor, date, time, patientInfo }: BookingSummaryProps) {
    return (
        <div className="space-y-8">
            <div className="flex flex-col items-center justify-center text-center space-y-2 mb-4">
                <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-600 mb-2">
                    <CheckCircle2 className="w-8 h-8" />
                </div>
                <h3 className="text-2xl font-bold text-gray-900">Review Booking</h3>
                <p className="text-gray-500 text-sm">Please verify your appointment details below</p>
            </div>

            <div className="bg-gray-50/50 rounded-[2rem] p-6 space-y-6">
                {/* Doctor info */}
                <div className="flex items-center gap-4 bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
                    <div className="relative w-14 h-14 rounded-xl overflow-hidden shadow-sm">
                        <Image src={doctor.avatar} alt={doctor.name} fill className="object-cover" />
                    </div>
                    <div className="text-left">
                        <h4 className="font-bold text-gray-900 leading-tight">{doctor.name}</h4>
                        <p className="text-indigo-600 text-xs font-bold uppercase tracking-widest">{doctor.specialty}</p>
                    </div>
                </div>

                {/* Grid details */}
                <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex items-start gap-3">
                        <div className="p-2 bg-indigo-50 rounded-lg">
                            <Calendar className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div>
                            <p className="text-[10px] uppercase font-bold text-gray-400">Date</p>
                            <p className="text-sm font-bold text-gray-800">{format(date, "MMM dd, yyyy")}</p>
                        </div>
                    </div>
                    <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex items-start gap-3">
                        <div className="p-2 bg-indigo-50 rounded-lg">
                            <Clock className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div>
                            <p className="text-[10px] uppercase font-bold text-gray-400">Time</p>
                            <p className="text-sm font-bold text-gray-800">{time}</p>
                        </div>
                    </div>
                    <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex items-start gap-3">
                        <div className="p-2 bg-indigo-50 rounded-lg">
                            <Video className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div>
                            <p className="text-[10px] uppercase font-bold text-gray-400">Type</p>
                            <p className="text-sm font-bold text-gray-800 capitalize">{patientInfo.type}</p>
                        </div>
                    </div>
                    <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex items-start gap-3">
                        <div className="p-2 bg-indigo-50 rounded-lg">
                            <User className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div>
                            <p className="text-[10px] uppercase font-bold text-gray-400">Patient</p>
                            <p className="text-sm font-bold text-gray-800 truncate">{patientInfo.name}</p>
                        </div>
                    </div>
                </div>

                {/* Price Summary */}
                <div className="pt-2">
                    <div className="flex justify-between items-center px-4 py-5 bg-indigo-600 rounded-2xl text-white shadow-xl shadow-indigo-100">
                        <div>
                            <p className="text-indigo-100 text-xs font-bold uppercase tracking-widest">Total Fees</p>
                            <h4 className="text-2xl font-bold">Rp {doctor.price.toLocaleString("id-ID")}</h4>
                        </div>
                        <div className="text-right">
                            <p className="text-indigo-100 text-[10px] font-medium italic">Incl. all services</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
