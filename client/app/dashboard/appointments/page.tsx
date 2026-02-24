"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
    Calendar,
    Clock,
    User as UserIcon,
    MoreHorizontal,
    CheckCircle2,
    XCircle,
    Clock3,
    ArrowLeft,
    Star,
    Loader2,
    Video,
    MessageSquare,
    Phone
} from "lucide-react";
import api from "@/lib/api";
import Navbar from "@/components/layout/Navbar";
import ReviewModal from "@/components/ReviewModal";

export default function AppointmentHistory() {
    const router = useRouter();
    const [appointments, setAppointments] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [user, setUser] = useState<any>(null);
    const [mounted, setMounted] = useState(false);
    const [reviewTarget, setReviewTarget] = useState<any>(null);

    useEffect(() => {
        setMounted(true);
        const userData = localStorage.getItem("user");
        if (!userData) {
            router.push("/login");
            return;
        }
        setUser(JSON.parse(userData));

        const fetchAppointments = async () => {
            try {
                const response = await api.get("/appointments/my");
                setAppointments(response.data.data);
            } catch (error) {
                console.error("Error fetching appointments:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchAppointments();
    }, [router]);

    const getStatusColor = (status: string) => {
        switch (status.toLowerCase()) {
            case "confirmed": return "bg-emerald-50 text-emerald-600 border-emerald-100";
            case "completed": return "bg-blue-50 text-blue-600 border-blue-100";
            case "cancelled": return "bg-rose-50 text-rose-600 border-rose-100";
            default: return "bg-amber-50 text-amber-600 border-amber-100";
        }
    };

    const handleStatusUpdate = async (id: number, status: string) => {
        try {
            await api.put(`/appointments/${id}/status`, { status });
            // Refresh
            const response = await api.get("/appointments/my");
            setAppointments(response.data.data);
        } catch (error) {
            console.error("Status update failed:", error);
        }
    };

    if (!mounted) return null;

    return (
        <>
            <main className="min-h-screen bg-white">
                <Navbar />

                <div className="pt-32 pb-20 px-4 md:px-8 max-w-7xl mx-auto">
                    {/* Header */}
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
                        <div>
                            <button
                                onClick={() => router.push("/dashboard")}
                                className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 transition-colors mb-4 group"
                            >
                                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                                <span className="font-medium">Back to Dashboard</span>
                            </button>
                            <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">Consultation <span className="text-indigo-600">History</span></h1>
                        </div>
                    </div>

                    {isLoading ? (
                        <div className="grid grid-cols-1 gap-4">
                            {[1, 2, 3, 4].map((i) => (
                                <div key={i} className="bg-white border border-gray-100 rounded-3xl p-6 animate-pulse">
                                    <div className="flex flex-col md:flex-row gap-6 md:items-center">
                                        <div className="flex items-center gap-4 min-w-[240px]">
                                            <div className="w-16 h-16 rounded-2xl bg-gray-100" />
                                            <div className="space-y-2">
                                                <div className="h-3 w-16 bg-gray-100 rounded" />
                                                <div className="h-5 w-32 bg-gray-100 rounded-lg" />
                                                <div className="h-3 w-20 bg-gray-50 rounded" />
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-6 flex-1">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-gray-50" />
                                                <div className="space-y-1">
                                                    <div className="h-2 w-10 bg-gray-100 rounded" />
                                                    <div className="h-4 w-20 bg-gray-100 rounded" />
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-gray-50" />
                                                <div className="space-y-1">
                                                    <div className="h-2 w-12 bg-gray-100 rounded" />
                                                    <div className="h-4 w-24 bg-gray-100 rounded" />
                                                </div>
                                            </div>
                                        </div>
                                        <div className="h-8 w-24 bg-gray-100 rounded-full" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-4">
                            {appointments.length > 0 ? (
                                appointments.map((app: any, idx) => (
                                    <motion.div
                                        key={app.id}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.05 }}
                                        className="bg-white border border-gray-100 rounded-3xl p-6 hover:shadow-xl hover:shadow-indigo-500/5 transition-all group scale-[0.99] hover:scale-[1]"
                                    >
                                        <div className="flex flex-col md:flex-row gap-6 md:items-center">
                                            {/* Profile/Doctor Info */}
                                            <div className="flex items-center gap-4 min-w-[240px]">
                                                <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center overflow-hidden border border-indigo-100 transition-transform group-hover:scale-105">
                                                    {user?.role === "doctor" ? (
                                                        app.user?.avatar ? (
                                                            <img src={app.user.avatar} alt="Patient Avatar" className="w-full h-full object-cover" />
                                                        ) : (
                                                            <UserIcon className="w-8 h-8 text-indigo-300" />
                                                        )
                                                    ) : (
                                                        app.doctor?.user?.avatar ? (
                                                            <img src={app.doctor.user.avatar} alt="Doctor Avatar" className="w-full h-full object-cover" />
                                                        ) : (
                                                            <UserIcon className="w-8 h-8 text-indigo-300" />
                                                        )
                                                    )}
                                                </div>
                                                <div>
                                                    <p className="text-sm text-gray-400 font-medium">
                                                        {user?.role === "doctor" ? "Patient" : "Specialist"}
                                                    </p>
                                                    <h3 className="text-lg font-bold text-gray-900 truncate">
                                                        {user?.role === "doctor" ? app.user?.name : app.doctor?.user?.name || "Doctor"}
                                                    </h3>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        {app.consultationType === "video" && <Video className="w-3 h-3 text-indigo-500" />}
                                                        {app.consultationType === "voice" && <Phone className="w-3 h-3 text-indigo-500" />}
                                                        {app.consultationType === "chat" && <MessageSquare className="w-3 h-3 text-indigo-500" />}
                                                        <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">{app.consultationType}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Date/Time */}
                                            <div className="flex flex-wrap gap-6 flex-1">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center">
                                                        <Calendar className="w-5 h-5 text-gray-400" />
                                                    </div>
                                                    <div>
                                                        <p className="text-xs text-gray-400 font-bold uppercase tracking-tighter">Date</p>
                                                        <p className="text-sm font-bold text-gray-700">{new Date(app.appointmentDate).toLocaleDateString('en-GB')}</p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center">
                                                        <Clock className="w-5 h-5 text-gray-400" />
                                                    </div>
                                                    <div>
                                                        <p className="text-xs text-gray-400 font-bold uppercase tracking-tighter">Time Slot</p>
                                                        <p className="text-sm font-bold text-gray-700">{app.startTime} - {app.endTime}</p>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Status */}
                                            <div className="flex items-center justify-between md:justify-end gap-4 w-full md:w-auto">
                                                <div className={`px-4 py-2 rounded-full border text-xs font-bold uppercase tracking-widest ${getStatusColor(app.status)}`}>
                                                    {app.status}
                                                </div>

                                                {/* Actions for Doctors */}
                                                {user?.role === "doctor" && app.status === "pending" && (
                                                    <div className="flex gap-2">
                                                        <button
                                                            onClick={() => handleStatusUpdate(app.id, "confirmed")}
                                                            className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/20"
                                                        >
                                                            <CheckCircle2 className="w-5 h-5" />
                                                        </button>
                                                        <button
                                                            onClick={() => handleStatusUpdate(app.id, "cancelled")}
                                                            className="w-10 h-10 rounded-xl bg-rose-500 text-white flex items-center justify-center hover:bg-rose-600 transition-colors shadow-lg shadow-rose-500/20"
                                                        >
                                                            <XCircle className="w-5 h-5" />
                                                        </button>
                                                    </div>
                                                )}

                                                {/* WhatsApp Button for Confirmed */}
                                                {app.status === "confirmed" && (
                                                    <a
                                                        href={`https://wa.me/${((user?.role === "doctor" ? (app.user?.phone_number || app.user?.phoneNumber) : (app.doctor?.user?.phone_number || app.doctor?.user?.phoneNumber)) || "628123456789").replace(/\D/g, '')}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl font-bold text-sm hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20"
                                                    >
                                                        <MessageSquare className="w-4 h-4" />
                                                        WhatsApp
                                                    </a>
                                                )}

                                                {user?.role === "patient" && app.status === "completed" && (
                                                    <button
                                                        onClick={() => setReviewTarget(app)}
                                                        className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-xl font-bold text-sm hover:bg-amber-600 transition-all shadow-lg shadow-amber-500/20"
                                                    >
                                                        <Star className="w-4 h-4" />
                                                        Rate
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                ))
                            ) : (
                                <div className="bg-white border border-dashed border-gray-200 rounded-[2.5rem] py-20 text-center">
                                    <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-6">
                                        <Clock3 className="w-10 h-10 text-gray-300" />
                                    </div>
                                    <h3 className="text-2xl font-bold text-gray-900 mb-2 font-outfit">No Consultations Yet</h3>
                                    <p className="text-gray-500 max-w-sm mx-auto">Your upcoming and past consultation history will appear here once you book an appointment.</p>
                                    <button
                                        onClick={() => router.push("/appointments")}
                                        className="mt-8 px-8 py-3 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-600/20"
                                    >
                                        Book Now
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </main>

            <AnimatePresence>
                {reviewTarget && (
                    <ReviewModal
                        doctorId={reviewTarget.doctorId}
                        doctorName={reviewTarget.doctor?.user?.name || "Doctor"}
                        appointmentId={reviewTarget.id}
                        onClose={() => setReviewTarget(null)}
                        onSuccess={async () => {
                            const response = await api.get("/appointments/my");
                            setAppointments(response.data.data);
                        }}
                    />
                )}
            </AnimatePresence>

        </>
    );
}
