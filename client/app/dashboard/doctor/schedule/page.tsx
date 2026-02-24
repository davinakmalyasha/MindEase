"use client";

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Calendar,
    Clock,
    Plus,
    ArrowLeft,
    Loader2,
    Trash2,
    CheckCircle2,
    AlertCircle,
    Info,
    ChevronLeft,
    ChevronRight
} from 'lucide-react';
import api from '@/lib/api';
import Navbar from '@/components/layout/Navbar';
import { cn } from '@/lib/utils';

interface SlotData {
    id: number;
    doctorId: number;
    date: string;
    startTime: string;
    endTime: string;
    isBooked: boolean;
}

export default function DoctorSchedule() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [slots, setSlots] = useState<SlotData[]>([]);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [weekOffset, setWeekOffset] = useState(0);

    const [form, setForm] = useState({
        date: '',
        start_time: '',
        end_time: ''
    });

    const fetchSlots = async (doctorId: number) => {
        try {
            const res = await api.get(`/doctors/slots/${doctorId}`);
            setSlots(Array.isArray(res.data) ? res.data : []);
        } catch (error) {
            console.error("Failed to fetch slots:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setMounted(true);
        const userData = JSON.parse(localStorage.getItem('user') || '{}');

        if (!userData || userData.role !== 'doctor') {
            router.push('/dashboard');
            return;
        }

        setUser(userData);
        fetchSlots(userData.id);
    }, [router]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setForm({ ...form, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setMessage(null);

        try {
            await api.post('/doctors/slots', {
                doctorId: user.id,
                ...form
            });
            setMessage({ type: 'success', text: 'Slot added successfully!' });
            fetchSlots(user.id);
            setForm({ date: '', start_time: '', end_time: '' });
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Failed to add slot' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async (slotId: number) => {
        try {
            await api.delete(`/doctors/slots/${slotId}`);
            setMessage({ type: 'success', text: 'Slot removed.' });
            setSlots((prev) => prev.filter((s) => s.id !== slotId));
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Failed to delete slot' });
        }
    };

    // Calendar logic
    const weekDays = useMemo(() => {
        const today = new Date();
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay() + 1 + weekOffset * 7); // Monday

        return Array.from({ length: 7 }, (_, i) => {
            const d = new Date(startOfWeek);
            d.setDate(startOfWeek.getDate() + i);
            return d;
        });
    }, [weekOffset]);

    const slotsByDate = useMemo(() => {
        const map: Record<string, SlotData[]> = {};
        slots.forEach((slot) => {
            const key = new Date(slot.date).toISOString().split('T')[0];
            if (!map[key]) map[key] = [];
            map[key].push(slot);
        });
        // Sort each day's slots by startTime
        Object.values(map).forEach((arr) => arr.sort((a, b) => a.startTime.localeCompare(b.startTime)));
        return map;
    }, [slots]);

    const isToday = (date: Date) => {
        const today = new Date();
        return date.toDateString() === today.toDateString();
    };

    const weekLabel = useMemo(() => {
        const start = weekDays[0];
        const end = weekDays[6];
        const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
        return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`;
    }, [weekDays]);

    if (!mounted) return null;
    if (!user && !loading) return null;

    return (
        <main className="min-h-screen bg-white pb-20">
            <Navbar />

            <div className="pt-32 px-4 md:px-8 max-w-7xl mx-auto">
                {/* Header */}
                <div className="mb-8">
                    <button
                        onClick={() => router.push("/dashboard")}
                        className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 transition-colors mb-4 group"
                    >
                        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                        <span className="font-medium">Back to Dashboard</span>
                    </button>
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-500">
                            <Calendar className="w-6 h-6" />
                        </div>
                        <div>
                            <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 font-outfit">
                                Consultation <span className="text-emerald-500">Schedule</span>
                            </h1>
                            <p className="text-gray-500 font-medium">Dr. {user?.name}, manage your availability.</p>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                    {/* Add Slot Form */}
                    <div className="lg:col-span-1">
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-indigo-500/5 p-6 sticky top-32">
                            <h2 className="text-lg font-bold text-gray-900 mb-5 flex items-center gap-2">
                                <Plus className="w-5 h-5 text-emerald-500" />
                                Add Slot
                            </h2>

                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Date</label>
                                    <input
                                        type="date"
                                        name="date"
                                        value={form.date}
                                        onChange={handleChange}
                                        required
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all font-medium text-gray-900 text-sm"
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Start</label>
                                        <input
                                            type="time"
                                            name="start_time"
                                            value={form.start_time}
                                            onChange={handleChange}
                                            required
                                            className="w-full px-3 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all font-medium text-gray-900 text-sm"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">End</label>
                                        <input
                                            type="time"
                                            name="end_time"
                                            value={form.end_time}
                                            onChange={handleChange}
                                            required
                                            className="w-full px-3 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all font-medium text-gray-900 text-sm"
                                        />
                                    </div>
                                </div>

                                <AnimatePresence>
                                    {message && (
                                        <motion.div
                                            initial={{ opacity: 0, height: 0 }}
                                            animate={{ opacity: 1, height: 'auto' }}
                                            exit={{ opacity: 0, height: 0 }}
                                            className={cn(
                                                "p-3 rounded-xl flex items-center gap-2",
                                                message.type === 'success' ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                                            )}
                                        >
                                            {message.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                                            <p className="text-xs font-bold">{message.text}</p>
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                                <button
                                    type="submit"
                                    disabled={isSubmitting}
                                    className="w-full py-3 bg-emerald-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-emerald-600 transition-all active:scale-95 shadow-lg shadow-emerald-200 disabled:opacity-70 text-sm"
                                >
                                    {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                    Open Slot
                                </button>
                            </form>

                            <div className="mt-6 p-3 bg-blue-50 rounded-xl border border-blue-100 flex gap-2">
                                <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                                <p className="text-[11px] text-blue-600 font-medium leading-relaxed">
                                    Ensure slots don't overlap. Patients will book these based on their preference.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Weekly Calendar Grid */}
                    <div className="lg:col-span-3">
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-500/5 overflow-hidden">
                            {/* Week Navigation */}
                            <div className="p-5 border-b border-gray-50 flex justify-between items-center bg-gray-50/50">
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={() => setWeekOffset((p) => p - 1)}
                                        className="w-9 h-9 rounded-xl bg-white border border-gray-100 flex items-center justify-center hover:bg-gray-100 transition-colors"
                                    >
                                        <ChevronLeft className="w-4 h-4 text-gray-500" />
                                    </button>
                                    <h2 className="text-sm font-bold text-gray-900">{weekLabel}</h2>
                                    <button
                                        onClick={() => setWeekOffset((p) => p + 1)}
                                        className="w-9 h-9 rounded-xl bg-white border border-gray-100 flex items-center justify-center hover:bg-gray-100 transition-colors"
                                    >
                                        <ChevronRight className="w-4 h-4 text-gray-500" />
                                    </button>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => setWeekOffset(0)}
                                        className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-bold hover:bg-emerald-100 transition-colors"
                                    >
                                        Today
                                    </button>
                                    <span className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs font-bold">
                                        {slots.length} Total Slots
                                    </span>
                                </div>
                            </div>

                            {loading ? (
                                <div className="p-12 flex justify-center">
                                    <Loader2 className="w-8 h-8 text-emerald-500 animate-spin" />
                                </div>
                            ) : (
                                <div className="grid grid-cols-7 divide-x divide-gray-50">
                                    {weekDays.map((day) => {
                                        const dateKey = day.toISOString().split('T')[0];
                                        const daySlots = slotsByDate[dateKey] || [];
                                        const today = isToday(day);
                                        const isPast = day < new Date(new Date().toDateString());

                                        return (
                                            <div key={dateKey} className={cn("min-h-[280px]", isPast && "opacity-50")}>
                                                {/* Day Header */}
                                                <div className={cn(
                                                    "px-3 py-3 text-center border-b border-gray-50",
                                                    today && "bg-emerald-50"
                                                )}>
                                                    <p className={cn(
                                                        "text-[10px] font-bold uppercase tracking-widest",
                                                        today ? "text-emerald-600" : "text-gray-400"
                                                    )}>
                                                        {day.toLocaleDateString('en-US', { weekday: 'short' })}
                                                    </p>
                                                    <p className={cn(
                                                        "text-lg font-black",
                                                        today ? "text-emerald-600" : "text-gray-900"
                                                    )}>
                                                        {day.getDate()}
                                                    </p>
                                                </div>

                                                {/* Slots */}
                                                <div className="p-2 space-y-2">
                                                    {daySlots.length === 0 ? (
                                                        <p className="text-gray-200 text-center text-[10px] font-medium py-4">No slots</p>
                                                    ) : (
                                                        daySlots.map((slot) => (
                                                            <motion.div
                                                                key={slot.id}
                                                                layout
                                                                initial={{ opacity: 0, scale: 0.9 }}
                                                                animate={{ opacity: 1, scale: 1 }}
                                                                className={cn(
                                                                    "rounded-xl p-2.5 text-[11px] font-bold relative group cursor-default",
                                                                    slot.isBooked
                                                                        ? "bg-amber-50 text-amber-700 border border-amber-100"
                                                                        : "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                                                )}
                                                            >
                                                                <div className="flex items-center gap-1 mb-1">
                                                                    <Clock className="w-3 h-3" />
                                                                    <span>{slot.startTime}</span>
                                                                </div>
                                                                <div className="text-[10px] opacity-70">{slot.endTime}</div>
                                                                <span className={cn(
                                                                    "text-[8px] font-black uppercase tracking-wider mt-1 inline-block px-1.5 py-0.5 rounded",
                                                                    slot.isBooked ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600"
                                                                )}>
                                                                    {slot.isBooked ? "BOOKED" : "OPEN"}
                                                                </span>

                                                                {/* Delete button for unbooked */}
                                                                {!slot.isBooked && !isPast && (
                                                                    <button
                                                                        onClick={() => handleDelete(slot.id)}
                                                                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg bg-white/80 border border-rose-100 flex items-center justify-center text-rose-400 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition-all"
                                                                    >
                                                                        <Trash2 className="w-3 h-3" />
                                                                    </button>
                                                                )}
                                                            </motion.div>
                                                        ))
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
