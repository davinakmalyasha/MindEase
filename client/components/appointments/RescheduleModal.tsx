"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { X, CalendarClock, Loader2, Check } from "lucide-react";
import DatePicker from "@/components/appointments/DatePicker";
import { cn } from "@/lib/utils";
import { useDoctorSlots } from "@/hooks/queries/useDoctorsQuery";
import { useRescheduleAppointment } from "@/hooks/queries/useAppointmentsQuery";

interface RescheduleModalProps {
    appointment: any;
    onClose: () => void;
}

export default function RescheduleModal({ appointment, onClose }: RescheduleModalProps) {
    const doctorId = appointment.doctor?.id || appointment.doctorId;
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [selectedSlot, setSelectedSlot] = useState<any | null>(null);
    const [done, setDone] = useState(false);
    const rescheduleMutation = useRescheduleAppointment();

    const { data: rawSlots = [], isFetching } = useDoctorSlots(doctorId);

    const slots = useMemo(
        () =>
            (Array.isArray(rawSlots) ? rawSlots : []).map((s: any) => ({
                id: s.id,
                startTime: s.startTime,
                endTime: s.endTime,
                isBooked: !!s.isBooked,
                date: s.date ? new Date(s.date) : null,
            })),
        [rawSlots]
    );

    const availableDates = useMemo(() => {
        const seen = new Set<string>();
        return slots
            .filter((s: any) => !s.isBooked && s.date)
            .filter((s: any) => {
                const key = s.date.toDateString();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map((s: any) => s.date);
    }, [slots]);

    const daySlots = selectedDate
        ? slots.filter((s: any) => !s.isBooked && s.date && s.date.toDateString() === selectedDate.toDateString())
        : [];

    const submit = async () => {
        if (!selectedDate || !selectedSlot) return;
        const dateKey = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, "0")}-${String(selectedDate.getDate()).padStart(2, "0")}`;
        try {
            await rescheduleMutation.mutateAsync({
                id: appointment.id,
                appointmentDate: dateKey,
                startTime: selectedSlot.startTime,
                endTime: selectedSlot.endTime,
                slotId: selectedSlot.id,
            });
            setDone(true);
        } catch {
            // error toast handled by the mutation
        }
    };

    if (done) {
        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
                    onClick={onClose}
                />
                <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-10 text-center"
                >
                    <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-5">
                        <Check className="w-8 h-8" />
                    </div>
                    <h2 className="text-2xl font-black text-gray-900 mb-2">Rescheduled!</h2>
                    <p className="text-gray-500 mb-6">
                        Your appointment moved to {selectedDate?.toLocaleDateString("en-GB")} at{" "}
                        {selectedSlot?.startTime}. Your doctor will re-confirm the new time.
                    </p>
                    <button
                        onClick={onClose}
                        className="px-8 py-3 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all"
                    >
                        Done
                    </button>
                </motion.div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
                onClick={onClose}
            />
            <motion.div
                initial={{ scale: 0.92, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="relative bg-white w-full max-w-lg rounded-3xl shadow-2xl p-8 max-h-[85vh] overflow-y-auto"
            >
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
                        <CalendarClock className="w-6 h-6 text-indigo-500" /> Reschedule
                    </h2>
                    <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 transition-colors" aria-label="Close">
                        <X className="w-5 h-5 text-gray-500" />
                    </button>
                </div>

                {isFetching ? (
                    <div className="flex items-center justify-center py-16 text-gray-400">
                        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading availability…
                    </div>
                ) : availableDates.length === 0 ? (
                    <div className="text-center py-10">
                        <p className="text-gray-500 font-medium mb-2">No available slots right now.</p>
                        <p className="text-sm text-gray-400">Check back later or contact your doctor.</p>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div>
                            <p className="text-sm font-black text-gray-900 mb-3">1. Pick a new date</p>
                            <DatePicker
                                selectedDate={selectedDate}
                                onChange={(d: Date) => {
                                    setSelectedDate(d);
                                    setSelectedSlot(null);
                                }}
                                availableDates={availableDates}
                            />
                        </div>
                        {selectedDate && (
                            <div>
                                <p className="text-sm font-black text-gray-900 mb-3">2. Pick a time</p>
                                <div className="grid grid-cols-3 gap-2">
                                    {daySlots.map((s: any) => (
                                        <button
                                            key={s.id}
                                            onClick={() => setSelectedSlot(s)}
                                            className={cn(
                                                "px-3 py-2.5 rounded-xl border-2 text-sm font-bold transition-all",
                                                selectedSlot?.id === s.id
                                                    ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                                                    : "border-gray-100 text-gray-600 hover:border-indigo-200"
                                            )}
                                        >
                                            {s.startTime}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <button
                            onClick={submit}
                            disabled={!selectedDate || !selectedSlot || rescheduleMutation.isPending}
                            className="w-full px-6 py-3.5 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                        >
                            {rescheduleMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
                            Confirm Reschedule
                        </button>
                    </div>
                )}
            </motion.div>
        </div>
    );
}
