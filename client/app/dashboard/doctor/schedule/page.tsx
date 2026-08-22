"use client";

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Calendar,
    Clock,
    Plus,
    Loader2,
    Trash2,
    CheckCircle2,
    AlertCircle,
    Info,
    ChevronLeft,
    ChevronRight,
    Repeat,
    RefreshCw,
    CalendarOff,
} from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";

interface SlotData {
    id: number;
    doctorId: number;
    date: string;
    startTime: string;
    endTime: string;
    isBooked: boolean;
}

interface PatternData {
    id: number;
    weekday: number;
    startTime: string;
    endTime: string;
    activeFrom: string;
}

const WEEKDAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function DoctorSchedule() {
    const { user } = useAuth();
    const { toast } = useToast();
    const [slots, setSlots] = useState<SlotData[]>([]);
    const [patterns, setPatterns] = useState<PatternData[]>([]);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isPatternSubmitting, setIsPatternSubmitting] = useState(false);
    const [weekOffset, setWeekOffset] = useState(0);

    const [form, setForm] = useState({
        date: "",
        start_time: "",
        end_time: "",
    });

    const [patternForm, setPatternForm] = useState({
        weekday: "1",
        start_time: "",
        end_time: "",
        weeks: "8",
    });

    const [awayUntil, setAwayUntil] = useState("");
    const [awayBusy, setAwayBusy] = useState(false);
    const [regenerating, setRegenerating] = useState<number | null>(null);

    const fetchSlots = async () => {
        try {
            // Resolve the authenticated doctor's profile id first
            const profileRes = await api.get("/users/profile");
            const doctorId = profileRes.data?.data?.doctorProfile?.id;
            if (!doctorId) {
                setLoading(false);
                return;
            }
            const [res, patRes] = await Promise.all([
                api.get(`/doctors/slots/${doctorId}`),
                api.get("/doctors/patterns"),
            ]);
            setSlots(Array.isArray(res.data?.data) ? res.data.data : []);
            setPatterns(Array.isArray(patRes.data?.data) ? patRes.data.data : []);
        } catch (error) {
            toast(getErrorMessage(error, "Failed to fetch slots"), "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user?.role === "doctor") fetchSlots();
    }, [user]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setForm({ ...form, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            await api.post("/doctors/slots", form);
            toast("Slot added successfully", "success");
            fetchSlots();
            setForm({ date: "", start_time: "", end_time: "" });
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to add slot"), "error");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async (slotId: number) => {
        try {
            await api.delete(`/doctors/slots/${slotId}`);
            toast("Slot removed", "success");
            setSlots((prev) => prev.filter((s) => s.id !== slotId));
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to delete slot"), "error");
        }
    };

    const handlePatternSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsPatternSubmitting(true);
        try {
            const res = await api.post("/doctors/patterns", {
                weekday: Number(patternForm.weekday),
                start_time: patternForm.start_time,
                end_time: patternForm.end_time,
                weeks: Number(patternForm.weeks),
            });
            toast(`Pattern created — ${res.data?.data?.generatedSlots?.length || 0} slots generated`, "success");
            fetchSlots();
            setPatternForm({ weekday: "1", start_time: "", end_time: "", weeks: "8" });
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to create pattern"), "error");
        } finally {
            setIsPatternSubmitting(false);
        }
    };

    const handlePatternDelete = async (patternId: number) => {
        try {
            await api.delete(`/doctors/patterns/${patternId}`);
            toast("Pattern removed", "success");
            setPatterns((prev) => prev.filter((p) => p.id !== patternId));
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to delete pattern"), "error");
        }
    };

    const handleRegenerate = async (patternId: number) => {
        setRegenerating(patternId);
        try {
            const res = await api.post(`/doctors/patterns/${patternId}/regenerate`);
            toast(`Regenerated — ${res.data?.data?.generatedSlots?.length || 0} slots added`, "success");
            fetchSlots();
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to regenerate pattern"), "error");
        } finally {
            setRegenerating(null);
        }
    };

    const handleAway = async () => {
        setAwayBusy(true);
        try {
            await api.post("/doctors/away", { awayUntil: awayUntil || null });
            toast(awayUntil ? "Away mode enabled — patients won't see slots until this date" : "Away mode disabled", "success");
            setAwayUntil("");
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to update away mode"), "error");
        } finally {
            setAwayBusy(false);
        }
    };

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
            const key = new Date(slot.date).toISOString().split("T")[0];
            if (!map[key]) map[key] = [];
            map[key].push(slot);
        });
        Object.values(map).forEach((arr) => arr.sort((a, b) => a.startTime.localeCompare(b.startTime)));
        return map;
    }, [slots]);

    const isToday = (date: Date) => date.toDateString() === new Date().toDateString();

    const weekLabel = useMemo(() => {
        const start = weekDays[0];
        const end = weekDays[6];
        const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
        return `${start.toLocaleDateString("en-US", opts)} â€“ ${end.toLocaleDateString("en-US", { ...opts, year: "numeric" })}`;
    }, [weekDays]);

    if (user?.role !== "doctor") {
        return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;
    }

    return (
        <DashboardLayout>
            <div className="mb-8">
                <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 font-outfit">
                    Consultation <span className="text-emerald-500">Schedule</span>
                </h1>
                <p className="text-gray-500 font-medium mt-2">Dr. {user?.name}, manage your availability.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Add Slot Form */}
                <div className="lg:col-span-1">
                    <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-indigo-500/5 p-6 lg:sticky lg:top-8">
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
                                    min={new Date().toISOString().split("T")[0]}
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
                                Ensure slots don&apos;t overlap. Patients will book these based on their preference.
                            </p>
                        </div>
                    </div>

                    {/* Weekly pattern */}
                    <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-indigo-500/5 p-6 mt-6 lg:sticky lg:top-[340px]">
                        <h2 className="text-lg font-bold text-gray-900 mb-1 flex items-center gap-2">
                            <Repeat className="w-5 h-5 text-indigo-500" />
                            Weekly Pattern
                        </h2>
                        <p className="text-[11px] text-gray-400 mb-5 leading-relaxed">
                            Set a recurring weekly slot — MindEase generates open slots for the next weeks automatically.
                        </p>

                        <form onSubmit={handlePatternSubmit} className="space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Day</label>
                                <select
                                    value={patternForm.weekday}
                                    onChange={(e) => setPatternForm({ ...patternForm, weekday: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 text-sm"
                                >
                                    {WEEKDAY_LABELS.map((label, i) => (
                                        <option key={i} value={i}>{label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Start</label>
                                    <input
                                        type="time"
                                        value={patternForm.start_time}
                                        onChange={(e) => setPatternForm({ ...patternForm, start_time: e.target.value })}
                                        required
                                        className="w-full px-3 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 text-sm"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">End</label>
                                    <input
                                        type="time"
                                        value={patternForm.end_time}
                                        onChange={(e) => setPatternForm({ ...patternForm, end_time: e.target.value })}
                                        required
                                        className="w-full px-3 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 text-sm"
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Weeks ahead</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={12}
                                    value={patternForm.weeks}
                                    onChange={(e) => setPatternForm({ ...patternForm, weeks: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 text-sm"
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={isPatternSubmitting}
                                className="w-full py-3 bg-indigo-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-600 transition-all active:scale-95 shadow-lg shadow-indigo-200 disabled:opacity-70 text-sm"
                            >
                                {isPatternSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Repeat className="w-4 h-4" />}
                                Create Pattern
                            </button>
                        </form>

                        {patterns.length > 0 && (
                            <div className="mt-5 pt-5 border-t border-gray-100 space-y-2">
                                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Active patterns</p>
                                {patterns.map((p) => (
                                    <div key={p.id} className="flex items-center justify-between px-3 py-2.5 bg-indigo-50/60 border border-indigo-100 rounded-xl">
                                        <div className="text-xs font-bold text-gray-700">
                                            {WEEKDAY_LABELS[p.weekday]}
                                            <span className="font-medium text-gray-400"> · {p.startTime}–{p.endTime}</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => handleRegenerate(p.id)}
                                                disabled={regenerating === p.id}
                                                className="w-7 h-7 rounded-lg bg-white border border-indigo-100 flex items-center justify-center text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all disabled:opacity-40"
                                                title="Regenerate upcoming weeks"
                                            >
                                                <RefreshCw className={cn("w-3.5 h-3.5", regenerating === p.id && "animate-spin")} />
                                            </button>
                                            <button
                                                onClick={() => handlePatternDelete(p.id)}
                                                className="w-7 h-7 rounded-lg bg-white border border-rose-100 flex items-center justify-center text-rose-400 hover:text-rose-600 hover:bg-rose-50 transition-all"
                                                title="Delete pattern"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Away mode */}
                        <div className="mt-5 pt-5 border-t border-gray-100 space-y-3">
                            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Away mode</p>
                            <p className="text-[11px] text-gray-400 leading-relaxed">
                                Pause bookings until a date. Patients won&apos;t see your slots during this period.
                            </p>
                            <div className="flex gap-2">
                                <input
                                    type="date"
                                    value={awayUntil}
                                    onChange={(e) => setAwayUntil(e.target.value)}
                                    min={new Date().toISOString().split("T")[0]}
                                    className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-100 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                                />
                                <button
                                    onClick={handleAway}
                                    disabled={awayBusy || (!awayUntil && false)}
                                    className="px-4 py-2.5 rounded-xl bg-amber-500 text-white text-xs font-bold hover:bg-amber-600 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                >
                                    {awayBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarOff className="w-3.5 h-3.5" />}
                                    {awayUntil ? "Enable" : "Disable"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Weekly Calendar Grid */}
                <div className="lg:col-span-3">
                    <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-500/5 overflow-hidden">
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
                            <div className="grid grid-cols-7 divide-x divide-gray-50 overflow-x-auto">
                                {weekDays.map((day) => {
                                    const dateKey = day.toISOString().split("T")[0];
                                    const daySlots = slotsByDate[dateKey] || [];
                                    const today = isToday(day);
                                    const isPast = day < new Date(new Date().toDateString());

                                    return (
                                        <div key={dateKey} className={cn("min-w-[110px] min-h-[280px]", isPast && "opacity-50")}>
                                            <div className={cn(
                                                "px-3 py-3 text-center border-b border-gray-50",
                                                today && "bg-emerald-50"
                                            )}>
                                                <p className={cn(
                                                    "text-[10px] font-bold uppercase tracking-widest",
                                                    today ? "text-emerald-600" : "text-gray-400"
                                                )}>
                                                    {day.toLocaleDateString("en-US", { weekday: "short" })}
                                                </p>
                                                <p className={cn("text-lg font-black", today ? "text-emerald-600" : "text-gray-900")}>
                                                    {day.getDate()}
                                                </p>
                                            </div>

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

                                                            {!slot.isBooked && !isPast && (
                                                                <button
                                                                    onClick={() => handleDelete(slot.id)}
                                                                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg bg-white/80 border border-rose-100 flex items-center justify-center text-rose-400 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition-all"
                                                                    title="Delete slot"
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
        </DashboardLayout>
    );
}
