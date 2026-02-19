"use client";

import { AppointmentWithDoctor } from "@/lib/data";
import { motion } from "framer-motion";
import { Star, Calendar, Clock, MessageCircle, ExternalLink, XCircle } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface AppointmentCardProps {
    appointment: AppointmentWithDoctor;
    onCancel?: (id: number) => void;
    onViewDetails?: (id: number) => void;
}

export default function AppointmentCard({ appointment, onCancel, onViewDetails }: AppointmentCardProps) {
    const statusStyles = {
        pending: "bg-amber-50 text-amber-700 border-amber-100",
        confirmed: "bg-emerald-50 text-emerald-700 border-emerald-100",
        completed: "bg-blue-50 text-blue-700 border-blue-100",
        cancelled: "bg-red-50 text-red-700 border-red-100",
    };

    const date = new Date(appointment.appointmentDate);
    const formattedDate = date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    const formattedTime = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="group bg-white rounded-3xl border border-gray-100 p-5 md:p-6 hover:shadow-xl hover:shadow-indigo-500/5 transition-all duration-300"
        >
            <div className="flex flex-col lg:flex-row gap-6 items-start lg:items-center">
                {/* Doctor Info */}
                <div className="flex gap-4 items-center min-w-[280px]">
                    <div className="relative w-16 h-16 rounded-full overflow-hidden border-2 border-indigo-50 group-hover:border-indigo-100 transition-colors">
                        <img
                            src={appointment.doctor.user?.avatar || appointment.doctor.avatar}
                            alt={appointment.doctor.user?.name || appointment.doctor.name}
                            className="w-full h-full object-cover"
                        />
                    </div>
                    <div>
                        <h4 className="font-bold text-gray-900 leading-tight mb-1 group-hover:text-indigo-600 transition-colors text-sm">
                            {appointment.doctor.user?.name || appointment.doctor.name}
                        </h4>
                        <p className="text-indigo-600 text-[10px] font-extrabold uppercase tracking-widest">
                            {appointment.doctor.specialty}
                        </p>
                        <div className="flex items-center gap-1 mt-1">
                            <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                            <span className="text-xs font-bold text-gray-500">{appointment.doctor.rating}</span>
                        </div>
                    </div>
                </div>

                {/* Details */}
                <div className="flex-1 grid grid-cols-2 gap-4 w-full">
                    <div className="space-y-1">
                        <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Appointment</p>
                        <div className="flex items-center gap-2 text-gray-700">
                            <Calendar className="w-4 h-4 text-indigo-400" />
                            <span className="text-sm font-semibold">{formattedDate}</span>
                        </div>
                        <div className="flex items-center gap-2 text-gray-700">
                            <Clock className="w-4 h-4 text-indigo-400" />
                            <span className="text-sm font-semibold text-gray-500">{formattedTime}</span>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Status</p>
                        <span className={cn(
                            "inline-flex items-center px-3 py-1 rounded-full text-[11px] font-bold border capitalize",
                            statusStyles[appointment.status]
                        )}>
                            <span className="w-1.5 h-1.5 rounded-full bg-current mr-1.5" />
                            {appointment.status}
                        </span>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 w-full lg:w-auto pt-4 lg:pt-0 border-t lg:border-t-0 border-gray-50">
                    {appointment.status === 'confirmed' && (
                        <a
                            href={`https://wa.me/${(appointment.doctor.user?.phone_number || "628123456789").replace(/\D/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 lg:flex-none flex items-center justify-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-3 rounded-2xl text-sm font-bold hover:bg-emerald-100 transition-all active:scale-95"
                        >
                            <MessageCircle className="w-4 h-4" />
                            WA
                        </a>
                    )}
                    <button
                        onClick={() => onViewDetails?.(appointment.id)}
                        className="flex-1 lg:flex-none flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-3 rounded-2xl text-sm font-bold hover:bg-indigo-100 transition-all active:scale-95"
                    >
                        <ExternalLink className="w-4 h-4" />
                        Details
                    </button>
                    {appointment.status === 'pending' && (
                        <button
                            onClick={() => onCancel?.(appointment.id)}
                            className="p-3 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all"
                            title="Cancel Appointment"
                        >
                            <XCircle className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>
        </motion.div>
    );
}
