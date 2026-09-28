"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Loader2, Check } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import DatePicker from "@/components/appointments/DatePicker";
import { cn } from "@/lib/utils";
import { formatDate, formatTimeRange } from "@/lib/format";
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

    const daySlots = useMemo(
        () =>
            selectedDate
                ? slots.filter(
                      (s: any) =>
                          !s.isBooked &&
                          s.date &&
                          s.date.toDateString() === selectedDate.toDateString()
                  )
                : [],
        [slots, selectedDate]
    );

    const submit = async () => {
        if (!selectedDate || !selectedSlot) return;
        const dateKey = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(
            2,
            "0"
        )}-${String(selectedDate.getDate()).padStart(2, "0")}`;
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
            <Dialog
                open
                onClose={onClose}
                title="Rescheduled"
                className="max-w-md text-center"
            >
                <div
                    aria-hidden="true"
                    className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
                >
                    <Check className="h-8 w-8" />
                </div>
                <p className="mb-6 text-gray-600 dark:text-gray-300">
                    Your appointment moved to {formatDate(selectedDate, "en")} at{" "}
                    <strong className="text-gray-900 dark:text-gray-50">
                        {formatTimeRange(selectedSlot?.startTime, selectedSlot?.endTime)}
                    </strong>
                    . Your doctor will re-confirm the new time.
                </p>
                <button
                    type="button"
                    onClick={onClose}
                    data-autofocus
                    className="rounded-2xl bg-indigo-600 px-8 py-3 font-bold text-white transition-colors hover:bg-indigo-700"
                >
                    Done
                </button>
            </Dialog>
        );
    }

    return (
        <Dialog
            open
            onClose={onClose}
            title={
                <span className="flex items-center gap-2">
                    <CalendarClock className="h-6 w-6 text-indigo-500" aria-hidden="true" />
                    Reschedule
                </span>
            }
        >
            {isFetching ? (
                <div className="flex items-center justify-center py-16 text-gray-500 dark:text-gray-400">
                    <Loader2 className="mr-2 h-6 w-6 animate-spin" aria-hidden="true" />
                    Loading availability…
                </div>
            ) : availableDates.length === 0 ? (
                <div className="py-10 text-center">
                    <p className="mb-2 font-medium text-gray-600 dark:text-gray-300">
                        No available slots right now.
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                        Check back later or contact your doctor.
                    </p>
                </div>
            ) : (
                <div className="max-h-[55vh] space-y-6 overflow-y-auto custom-scrollbar">
                    <section>
                        <h3 className="mb-3 text-sm font-bold text-gray-900 dark:text-gray-50">
                            1. Pick a new date
                        </h3>
                        <DatePicker
                            selectedDate={selectedDate}
                            onChange={(d: Date) => {
                                setSelectedDate(d);
                                // A slot belongs to exactly one day; keeping the
                                // old selection would submit a mismatched pair.
                                setSelectedSlot(null);
                            }}
                            availableDates={availableDates}
                        />
                    </section>

                    {selectedDate && (
                        <section>
                            <h3 className="mb-3 text-sm font-bold text-gray-900 dark:text-gray-50">
                                2. Pick a time
                            </h3>
                            {daySlots.length === 0 ? (
                                <p className="text-sm text-gray-500 dark:text-gray-400">
                                    No open times on this date. Try another day.
                                </p>
                            ) : (
                                <div className="grid grid-cols-3 gap-2">
                                    {daySlots.map((s: any) => (
                                        <button
                                            key={s.id}
                                            type="button"
                                            aria-pressed={selectedSlot?.id === s.id}
                                            onClick={() => setSelectedSlot(s)}
                                            className={cn(
                                                "rounded-xl border-2 px-3 py-2.5 text-sm font-bold transition-all",
                                                selectedSlot?.id === s.id
                                                    ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                                                    : "border-gray-100 text-gray-600 hover:border-indigo-200 dark:border-gray-700 dark:text-gray-300"
                                            )}
                                        >
                                            {s.startTime}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>
                    )}

                    <button
                        type="button"
                        onClick={submit}
                        disabled={!selectedDate || !selectedSlot || rescheduleMutation.isPending}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-6 py-3.5 font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40"
                    >
                        {rescheduleMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                            <CalendarClock className="h-4 w-4" aria-hidden="true" />
                        )}
                        Confirm reschedule
                    </button>
                </div>
            )}
        </Dialog>
    );
}
