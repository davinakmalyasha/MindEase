"use client";

import { useState, useEffect, useCallback } from "react";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import AppointmentCard from "@/components/appointments/AppointmentCard";
import AppointmentFilters from "@/components/appointments/AppointmentFilters";
import EmptyState from "@/components/appointments/EmptyState";
import { motion, AnimatePresence } from "framer-motion";
import { Calendar, ChevronRight } from "lucide-react";
import Link from "next/link";
import api, { getErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";

type Status = 'all' | 'pending' | 'confirmed' | 'completed' | 'cancelled';

export default function MyAppointmentsPage() {
    const [appointments, setAppointments] = useState<any[]>([]);
    const [activeStatus, setActiveStatus] = useState<Status>('all');
    const [isLoading, setIsLoading] = useState(true);
    const { user } = useAuth();
    const { toast } = useToast();

    const fetchAppointments = useCallback(async () => {
        try {
            const res = await api.get("/appointments/my");
            setAppointments(res.data?.data || []);
        } catch (error) {
            toast(getErrorMessage(error, "Failed to load appointments"), "error");
        } finally {
            setIsLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        fetchAppointments();
    }, [fetchAppointments]);

    const filteredAppointments = activeStatus === 'all'
        ? appointments
        : appointments.filter(app => app.status === activeStatus);

    const handleCancel = async (id: number) => {
        try {
            await api.put(`/appointments/${id}/status`, { status: "cancelled" });
            toast("Appointment cancelled", "success");
            setAppointments(prev => prev.map(app =>
                app.id === id ? { ...app, status: 'cancelled' } : app
            ));
        } catch (error) {
            toast(getErrorMessage(error, "Failed to cancel appointment"), "error");
        }
    };

    const handleViewDetails = (id: number) => {
        // Scroll to the appointment in the dashboard history is not possible here;
        // open the booking history page for full detail.
        window.location.href = "/dashboard/appointments";
    };

    return (
        <main className="min-h-screen bg-white">
            <Navbar />

            <div className="pt-32 pb-20 px-4 md:px-8 max-w-6xl mx-auto">
                <header className="mb-10">
                    <motion.div
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex flex-col md:flex-row md:items-end justify-between gap-6"
                    >
                        <div>
                            <nav className="flex items-center gap-2 text-sm font-medium text-gray-400 mb-4">
                                <Link href="/" className="hover:text-indigo-600 transition-colors">Home</Link>
                                <ChevronRight className="w-4 h-4" />
                                <span className="text-gray-900">My Appointments</span>
                            </nav>
                            <h1 className="text-4xl font-extrabold text-gray-900 mb-2">My Appointments</h1>
                            <p className="text-gray-500 font-medium">
                                You have <span className="text-indigo-600 font-bold">{appointments.length}</span> consultations recorded
                            </p>
                        </div>

                        <Link
                            href="/appointments"
                            className="bg-gray-50 text-gray-900 px-6 py-3 rounded-2xl font-bold border border-gray-100 hover:bg-white hover:shadow-lg transition-all active:scale-95 flex items-center gap-2"
                        >
                            <Calendar className="w-5 h-5 text-indigo-500" />
                            Book New
                        </Link>
                    </motion.div>
                </header>

                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="mb-8"
                >
                    <AppointmentFilters
                        activeStatus={activeStatus}
                        onStatusChange={setActiveStatus}
                    />
                </motion.div>

                <div className="space-y-4">
                    {isLoading ? (
                        Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="h-32 w-full bg-gray-50 animate-pulse rounded-3xl" />
                        ))
                    ) : (
                        <AnimatePresence mode="popLayout">
                            {filteredAppointments.length > 0 ? (
                                filteredAppointments.map((app) => (
                                    <AppointmentCard
                                        key={app.id}
                                        appointment={app}
                                        onCancel={app.status === "pending" ? handleCancel : undefined}
                                        onViewDetails={handleViewDetails}
                                    />
                                ))
                            ) : (
                                <EmptyState />
                            )}
                        </AnimatePresence>
                    )}
                </div>

                {user?.role === "doctor" && (
                    <p className="mt-6 text-sm text-gray-400 text-center">
                        You are viewing this page as a patient view. Doctors should use the{" "}
                        <Link href="/dashboard/appointments" className="text-indigo-600 font-semibold hover:underline">
                            Dashboard History
                        </Link>.
                    </p>
                )}
            </div>

            <Footer />
        </main>
    );
}
