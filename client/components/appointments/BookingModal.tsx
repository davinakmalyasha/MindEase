"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { isSameDay } from "date-fns";
import { Doctor } from "@/lib/types/doctor";
import api, { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/Toast";
import Dialog from "@/components/ui/Dialog";
import DatePicker from "./DatePicker";
import TimeSlots, { RealSlot } from "./TimeSlots";
import PatientForm from "./PatientForm";
import BookingSummary from "./BookingSummary";
import { useBookAppointment } from "@/hooks/queries/useAppointmentsQuery";
import { useDoctorSlots } from "@/hooks/queries/useDoctorsQuery";

interface BookingModalProps {
    doctor: Doctor;
    onClose: () => void;
}

const STEPS = [
    { id: 1, name: "Date" },
    { id: 2, name: "Time" },
    { id: 3, name: "Details" },
    { id: 4, name: "Confirm" },
];

export default function BookingModal({ doctor, onClose }: BookingModalProps) {
    const [step, setStep] = useState(1);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [selectedTime, setSelectedTime] = useState<string | null>(null);
    const [selectedSlot, setSelectedSlot] = useState<RealSlot | null>(null);
    const [patientInfo, setPatientInfo] = useState({
        name: "",
        notes: "",
        type: "video" as "video" | "voice" | "chat",
    });
    const [isBooking, setIsBooking] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);
    const [usePackage, setUsePackage] = useState(false);
    const [myPackages, setMyPackages] = useState<any[]>([]);
    const { toast } = useToast();
    const bookMutation = useBookAppointment();

    useEffect(() => {
        let cancelled = false;
        api
            .get("/packages/my")
            .then((res) => {
                if (cancelled) return;
                const purchases = (res.data?.data || []).filter(
                    (p: any) =>
                        p.status === "active" &&
                        p.sessionsLeft > 0 &&
                        p.package?.doctor?.id === doctor.id
                );
                setMyPackages(purchases);
            })
            .catch(() => {
                /* Package lookup is best-effort; booking still works without it. */
            });
        return () => {
            cancelled = true;
        };
    }, [doctor.id]);

    const { data: rawSlots = [], isFetching: slotsLoading } = useDoctorSlots(doctor.id);

    const slots: RealSlot[] = useMemo(
        () =>
            Array.isArray(rawSlots)
                ? rawSlots.map((s: any) => ({
                      id: s.id,
                      startTime: s.startTime,
                      endTime: s.endTime,
                      isBooked: !!s.isBooked,
                      date: s.date ? new Date(s.date) : null,
                  }))
                : [],
        [rawSlots]
    );

    const daySlots = useMemo(
        () =>
            selectedDate
                ? slots.filter((s) => s.date && isSameDay(s.date, selectedDate))
                : slots,
        [slots, selectedDate]
    );

    const handleBooking = useCallback(async () => {
        if (!selectedSlot) {
            toast("That time is no longer available. Please pick another slot.", "error");
            return;
        }
        setIsBooking(true);
        try {
            await bookMutation.mutateAsync({
                doctorId: doctor.id,
                appointmentDate: selectedDate,
                startTime: selectedTime,
                endTime: selectedSlot.endTime,
                consultationType: patientInfo.type,
                notes: patientInfo.notes,
                slotId: selectedSlot.id,
                idempotencyKey:
                    crypto.randomUUID?.() ??
                    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                packagePurchaseId: usePackage ? myPackages[0]?.id : undefined,
            });
            setIsSuccess(true);
        } catch (error: any) {
            toast(getErrorMessage(error, "Failed to book appointment"), "error");
        } finally {
            setIsBooking(false);
        }
    }, [
        bookMutation,
        doctor.id,
        myPackages,
        patientInfo,
        selectedDate,
        selectedSlot,
        selectedTime,
        toast,
        usePackage,
    ]);

    const onSelectTime = (time: string) => {
        setSelectedTime(time);
        setSelectedSlot(daySlots.find((s) => s.startTime === time) ?? null);
    };

    const isNextDisabled = () => {
        if (step === 1 && !selectedDate) return true;
        // A time that no longer maps to a real slot must not advance — the
        // server has no way to book a slot we cannot identify.
        if (step === 2 && (!selectedTime || !selectedSlot)) return true;
        if (step === 3 && !patientInfo.name.trim()) return true;
        return false;
    };

    if (isSuccess) {
        return (
            <Dialog
                open
                onClose={onClose}
                title="Booking confirmed"
                className="max-w-md text-center"
            >
                <div
                    aria-hidden="true"
                    className="mx-auto mb-4 flex h-20 w-20 animate-bounce items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
                >
                    <Check className="h-10 w-10" />
                </div>
                <p className="mx-auto max-w-xs text-gray-600 dark:text-gray-300">
                    Your appointment with{" "}
                    <span className="font-bold text-indigo-600 dark:text-indigo-400">
                        {doctor.name}
                    </span>{" "}
                    has been successfully scheduled.
                </p>
                <div className="mt-6 space-y-3">
                    <Link
                        href="/dashboard/appointments"
                        onClick={onClose}
                        className="block w-full rounded-2xl bg-indigo-600 py-4 font-bold text-white shadow-lg shadow-indigo-100 transition-all hover:bg-indigo-700 active:scale-95"
                    >
                        View appointments
                    </Link>
                    <button
                        type="button"
                        onClick={onClose}
                        className="block w-full rounded-2xl bg-gray-50 py-4 font-bold text-gray-600 transition-all hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300"
                    >
                        Done
                    </button>
                </div>
            </Dialog>
        );
    }

    const isLastStep = step === STEPS.length;

    return (
        <Dialog
            open
            onClose={onClose}
            title={
                <span className="flex items-center gap-4">
                    <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-indigo-100 bg-indigo-50">
                        <NextImage
                            src={doctor.avatar}
                            alt=""
                            fill
                            sizes="48px"
                            className="object-cover"
                        />
                    </span>
                    <span className="min-w-0">
                        <span className="block truncate text-xl font-bold text-gray-900 dark:text-gray-50">
                            {doctor.name}
                        </span>
                        <span className="block text-xs font-bold uppercase tracking-widest text-indigo-600">
                            {doctor.specialty}
                        </span>
                    </span>
                </span>
            }
            className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden p-0"
        >
            <ol
                aria-label="Booking progress"
                className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-6 pb-6 pt-2 md:px-8 dark:border-gray-700"
            >
                {STEPS.map((s) => {
                    const done = step > s.id;
                    const current = step === s.id;
                    return (
                        <li key={s.id} className="flex flex-1 flex-col items-center gap-2">
                            <span
                                aria-hidden="true"
                                className={cn(
                                    "h-1.5 w-full rounded-full transition-all duration-500",
                                    step >= s.id
                                        ? "bg-indigo-600"
                                        : "bg-gray-100 dark:bg-gray-700"
                                )}
                            />
                            <span
                                className={cn(
                                    "text-[10px] font-bold uppercase tracking-widest transition-colors",
                                    current
                                        ? "text-indigo-600"
                                        : "text-gray-400 dark:text-gray-500"
                                )}
                            >
                                {s.name}
                                {done && <span className="sr-only"> (completed)</span>}
                            </span>
                            {current && (
                                <span className="sr-only">
                                    Step {s.id} of {STEPS.length} in progress
                                </span>
                            )}
                        </li>
                    );
                })}
            </ol>

            <div className="custom-scrollbar flex-1 overflow-y-auto p-6 md:p-8">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={step}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{ duration: 0.2 }}
                    >
                        {step === 1 && (
                            <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} />
                        )}
                        {step === 2 && (
                            <TimeSlots
                                selectedTime={selectedTime}
                                onChange={onSelectTime}
                                slots={daySlots}
                                loading={slotsLoading}
                            />
                        )}
                        {step === 3 && (
                            <PatientForm patientInfo={patientInfo} onChange={setPatientInfo} />
                        )}
                        {step === 3 && myPackages.length > 0 && (
                            <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                                <span>
                                    <span className="block text-sm font-bold text-gray-900 dark:text-gray-50">
                                        Use a package session
                                    </span>
                                    <span className="block text-xs text-gray-600 dark:text-gray-300">
                                        {myPackages[0].package.name} · {myPackages[0].sessionsLeft}{" "}
                                        session{myPackages[0].sessionsLeft === 1 ? "" : "s"} left
                                    </span>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={usePackage}
                                    onChange={(e) => setUsePackage(e.target.checked)}
                                    className="h-5 w-5 accent-emerald-500"
                                />
                            </label>
                        )}
                        {step === 4 && selectedDate && selectedTime && (
                            <BookingSummary
                                doctor={doctor}
                                date={selectedDate}
                                time={selectedTime}
                                patientInfo={patientInfo}
                            />
                        )}
                    </motion.div>
                </AnimatePresence>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-6 border-t border-gray-100 bg-gray-50/50 px-6 py-5 md:px-8 dark:border-gray-700 dark:bg-gray-800/50">
                {step > 1 ? (
                    <button
                        type="button"
                        onClick={() => setStep((s) => s - 1)}
                        className="flex items-center gap-2 font-bold text-gray-500 transition-colors hover:text-indigo-600"
                    >
                        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                        Back
                    </button>
                ) : (
                    <span />
                )}

                <button
                    type="button"
                    onClick={() => (isLastStep ? handleBooking() : setStep((s) => s + 1))}
                    disabled={isNextDisabled() || isBooking}
                    className={cn(
                        "flex-1 rounded-2xl py-4 font-bold transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 md:flex-none md:min-w-[200px]",
                        isLastStep
                            ? "bg-indigo-600 text-white shadow-lg shadow-indigo-100"
                            : "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                    )}
                >
                    {isBooking ? (
                        "Confirming…"
                    ) : isLastStep ? (
                        "Confirm & schedule"
                    ) : (
                        <span className="flex items-center justify-center gap-2">
                            Continue
                            <ChevronRight className="h-5 w-5" aria-hidden="true" />
                        </span>
                    )}
                </button>
            </div>
        </Dialog>
    );
}
