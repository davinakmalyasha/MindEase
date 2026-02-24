"use client";

import { useState, useEffect, useMemo } from "react";
import Navbar from "@/components/layout/Navbar";
import DoctorCard from "@/components/appointments/DoctorCard";
import DoctorCardSkeleton from "@/components/appointments/DoctorCardSkeleton";
import {
    Search,
    SlidersHorizontal,
    ArrowUpDown,
    Star,
    TrendingDown,
    Briefcase,
    Users
} from "lucide-react";
import api from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import BookingModal from "@/components/appointments/BookingModal";

type SortOption = "rating" | "price_low" | "price_high" | "experience";
type PriceRange = "all" | "under100" | "100to300" | "over300";

const SORT_OPTIONS: { value: SortOption; label: string; icon: React.ReactNode }[] = [
    { value: "rating", label: "Top Rated", icon: <Star className="w-3.5 h-3.5" /> },
    { value: "price_low", label: "Lowest Price", icon: <TrendingDown className="w-3.5 h-3.5" /> },
    { value: "price_high", label: "Highest Price", icon: <TrendingDown className="w-3.5 h-3.5 rotate-180" /> },
    { value: "experience", label: "Most Experienced", icon: <Briefcase className="w-3.5 h-3.5" /> },
];

const PRICE_RANGES: { value: PriceRange; label: string }[] = [
    { value: "all", label: "All Prices" },
    { value: "under100", label: "< Rp 100k" },
    { value: "100to300", label: "100k – 300k" },
    { value: "over300", label: "> Rp 300k" },
];

export default function AppointmentPage() {
    const [doctors, setDoctors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedSpecialty, setSelectedSpecialty] = useState("All");
    const [selectedDoctor, setSelectedDoctor] = useState<any>(null);
    const [sortBy, setSortBy] = useState<SortOption>("rating");
    const [priceRange, setPriceRange] = useState<PriceRange>("all");
    const [showFilters, setShowFilters] = useState(false);

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

    const specialties = useMemo(() =>
        ["All", ...new Set(doctors.map((d: any) => d.specialty))],
        [doctors]
    );

    const filteredAndSortedDoctors = useMemo(() => {
        let result = doctors.filter((doc: any) => {
            const matchesSearch =
                doc.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                doc.specialty.toLowerCase().includes(searchQuery.toLowerCase());
            const matchesSpecialty =
                selectedSpecialty === "All" || doc.specialty === selectedSpecialty;

            let matchesPrice = true;
            if (priceRange === "under100") matchesPrice = doc.price < 100000;
            else if (priceRange === "100to300") matchesPrice = doc.price >= 100000 && doc.price <= 300000;
            else if (priceRange === "over300") matchesPrice = doc.price > 300000;

            return matchesSearch && matchesSpecialty && matchesPrice;
        });

        result.sort((a: any, b: any) => {
            switch (sortBy) {
                case "rating": return b.rating - a.rating;
                case "price_low": return a.price - b.price;
                case "price_high": return b.price - a.price;
                case "experience": return b.experience - a.experience;
                default: return 0;
            }
        });

        return result;
    }, [doctors, searchQuery, selectedSpecialty, priceRange, sortBy]);

    return (
        <main className="min-h-screen bg-white">
            <Navbar />

            <div className="pt-32 pb-20 px-4 md:px-8 max-w-7xl mx-auto">
                {/* Header */}
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

                {/* Search Bar */}
                <div className="flex flex-col gap-4 mb-6">
                    <div className="flex flex-col md:flex-row gap-3">
                        <div className="relative flex-1 group">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5 group-focus-within:text-indigo-500 transition-colors" />
                            <input
                                type="text"
                                placeholder="Search by name or specialty..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-12 pr-4 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 font-medium text-gray-900"
                            />
                        </div>
                        <button
                            onClick={() => setShowFilters(!showFilters)}
                            className={`flex items-center justify-center gap-2 px-6 py-4 rounded-2xl font-bold text-sm transition-all ${showFilters
                                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200"
                                    : "bg-gray-50 text-gray-600 border border-gray-100 hover:bg-gray-100"
                                }`}
                        >
                            <SlidersHorizontal className="w-4 h-4" />
                            Filters
                        </button>
                    </div>
                </div>

                {/* Filter Panel */}
                <AnimatePresence>
                    {showFilters && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3 }}
                            className="overflow-hidden mb-8"
                        >
                            <div className="bg-gray-50/50 border border-gray-100 rounded-3xl p-6 space-y-6">
                                {/* Specialty Chips */}
                                <div>
                                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 ml-1">Specialization</p>
                                    <div className="flex flex-wrap gap-2">
                                        {specialties.map((spec) => (
                                            <button
                                                key={spec}
                                                onClick={() => setSelectedSpecialty(spec)}
                                                className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${selectedSpecialty === spec
                                                        ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200"
                                                        : "bg-white text-gray-600 border border-gray-100 hover:border-indigo-200 hover:text-indigo-600"
                                                    }`}
                                            >
                                                {spec}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Price Range */}
                                <div>
                                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 ml-1">Price Range</p>
                                    <div className="flex flex-wrap gap-2">
                                        {PRICE_RANGES.map((range) => (
                                            <button
                                                key={range.value}
                                                onClick={() => setPriceRange(range.value)}
                                                className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${priceRange === range.value
                                                        ? "bg-emerald-600 text-white shadow-lg shadow-emerald-200"
                                                        : "bg-white text-gray-600 border border-gray-100 hover:border-emerald-200 hover:text-emerald-600"
                                                    }`}
                                            >
                                                {range.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Sort By */}
                                <div>
                                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 ml-1">Sort By</p>
                                    <div className="flex flex-wrap gap-2">
                                        {SORT_OPTIONS.map((option) => (
                                            <button
                                                key={option.value}
                                                onClick={() => setSortBy(option.value)}
                                                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold transition-all ${sortBy === option.value
                                                        ? "bg-amber-500 text-white shadow-lg shadow-amber-200"
                                                        : "bg-white text-gray-600 border border-gray-100 hover:border-amber-200 hover:text-amber-600"
                                                    }`}
                                            >
                                                {option.icon}
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Results Count */}
                {!isLoading && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex items-center gap-2 mb-6"
                    >
                        <Users className="w-4 h-4 text-gray-400" />
                        <span className="text-sm font-bold text-gray-400">
                            {filteredAndSortedDoctors.length} specialist{filteredAndSortedDoctors.length !== 1 ? "s" : ""} found
                        </span>
                    </motion.div>
                )}

                {/* Doctor List */}
                {isLoading ? (
                    <div className="grid grid-cols-1 gap-6">
                        {[1, 2, 3].map((i) => (
                            <DoctorCardSkeleton key={i} />
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-6">
                        <AnimatePresence mode="popLayout">
                            {filteredAndSortedDoctors.length > 0 ? (
                                filteredAndSortedDoctors.map((doc: any, idx: number) => (
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
