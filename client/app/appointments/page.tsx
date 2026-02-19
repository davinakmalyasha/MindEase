"use client";

import { useState, useEffect } from "react";
import Navbar from "@/components/layout/Navbar";
import DoctorCard from "@/components/appointments/DoctorCard";
import { Search, Filter, Loader2 } from "lucide-react";
import api from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import BookingModal from "@/components/appointments/BookingModal";

export default function AppointmentPage() {
    const [doctors, setDoctors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedSpecialty, setSelectedSpecialty] = useState("All");
    const [selectedDoctor, setSelectedDoctor] = useState<any>(null);

    useEffect(() => {
        const fetchDoctors = async () => {
            try {
                const response = await api.get("/doctors");
                setDoctors(response.data.data);
            } catch (error) {
                console.error("Error fetching doctors:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchDoctors();
    }, []);

    const filteredDoctors = doctors.filter((doc: any) => {
        const matchesSearch = doc.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            doc.specialty.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesSpecialty = selectedSpecialty === "All" || doc.specialty === selectedSpecialty;
        return matchesSearch && matchesSpecialty;
    });

    const specialties = ["All", ...new Set(doctors.map((d: any) => d.specialty))];

    return (
        <main className="min-h-screen bg-white">
            <Navbar />

            <div className="pt-32 pb-20 px-4 md:px-8 max-w-7xl mx-auto">
                <header className="mb-12">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                    >
                        <p className="text-indigo-600 font-bold tracking-widest uppercase text-sm mb-2">Find Support</p>
                        <h1 className="text-4xl md:text-5xl font-extrabold text-gray-900 mb-4">
                            Book an <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600">Appointment</span>
                        </h1>
                        <p className="text-gray-600 max-w-2xl">Connect with our network of experienced mental health professionals tailored to your needs.</p>
                    </motion.div>
                </header>

                {/* Filters */}
                <div className="flex flex-col md:flex-row gap-4 mb-12">
                    <div className="relative flex-1 group">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5 group-focus-within:text-indigo-500 transition-colors" />
                        <input
                            type="text"
                            placeholder="Search by name or specialty..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-12 pr-4 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                    </div>
                    <div className="relative md:w-64">
                        <Filter className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
                        <select
                            value={selectedSpecialty}
                            onChange={(e) => setSelectedSpecialty(e.target.value)}
                            className="w-full pl-12 pr-10 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 appearance-none"
                        >
                            {specialties.map(s => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-20">
                        <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
                        <p className="text-gray-500 font-medium font-outfit">Finding available specialists...</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-6">
                        <AnimatePresence mode="popLayout">
                            {filteredDoctors.length > 0 ? (
                                filteredDoctors.map((doc: any, idx) => (
                                    <motion.div
                                        key={doc.id}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.05 }}
                                        layout
                                    >
                                        <DoctorCard
                                            doctor={{
                                                id: doc.id,
                                                name: doc.user.name,
                                                specialty: doc.specialty,
                                                image: doc.user.avatar || "/doctor-placeholder.jpg",
                                                rating: doc.rating,
                                                price: doc.price,
                                                availability: doc.availability,
                                                experience: doc.experience,
                                                bio: doc.bio
                                            }}
                                            onSelect={(d) => setSelectedDoctor(d)}
                                        />
                                    </motion.div>
                                ))
                            ) : (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="py-20 text-center"
                                >
                                    <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <Search className="w-10 h-10 text-gray-300" />
                                    </div>
                                    <h3 className="text-xl font-bold text-gray-900 mb-2 font-outfit">No Specialists Found</h3>
                                    <p className="text-gray-500">Try adjusting your filters or search keywords.</p>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </div>

            <AnimatePresence>
                {selectedDoctor && (
                    <BookingModal
                        doctor={selectedDoctor}
                        onClose={() => setSelectedDoctor(null)}
                    />
                )}
            </AnimatePresence>
        </main>
    );
}
