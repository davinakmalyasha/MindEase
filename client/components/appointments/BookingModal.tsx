"use client";

import { useState } from "react";
import { Doctor } from "@/lib/types/doctor";
import api from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, Check } from "lucide-react";
import NextImage from "next/image";
import DatePicker from "./DatePicker";
import TimeSlots from "./TimeSlots";
import PatientForm from "./PatientForm";
import BookingSummary from "./BookingSummary";
import { cn } from "@/lib/utils";
import Link from "next/link";

interface BookingModalProps {
    doctor: Doctor;
    onClose: () => void;
}

export default function BookingModal({ doctor, onClose }: BookingModalProps) {
    const [step, setStep] = useState(1);
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const [selectedTime, setSelectedTime] = useState<string | null>(null);
    const [patientInfo, setPatientInfo] = useState({
        name: "",
        notes: "",
        type: "video" as "video" | "voice" | "chat"
    });
    const [isBooking, setIsBooking] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);

    const steps = [
        { id: 1, name: "Date" },
        { id: 2, name: "Time" },
        { id: 3, name: "Details" },
        { id: 4, name: "Confirm" }
    ];

    const nextStep = () => {
        if (step < 4) setStep(step + 1);
        else handleBooking();
    };

    const prevStep = () => {
        if (step > 1) setStep(step - 1);
    };

    const handleBooking = async () => {
        setIsBooking(true);
        try {
            await api.post("/appointments/book", {
                doctorId: doctor.id,
                appointmentDate: selectedDate,
                startTime: selectedTime,
                endTime: selectedTime, // Placeholder or calculate
                consultationType: patientInfo.type,
                notes: patientInfo.notes,
            });
            setIsSuccess(true);
        } catch (error: any) {
            console.error("Booking failed:", error);
            alert("Gagal melakukan booking: " + (error.response?.data?.message || error.message));
        } finally {
            setIsBooking(false);
        }
    };

    const isNextDisabled = () => {
        if (step === 1 && !selectedDate) return true;
        if (step === 2 && !selectedTime) return true;
        if (step === 3 && !patientInfo.name) return true;
        return false;
    };

    if (isSuccess) {
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
                    className="relative bg-white w-full max-w-lg rounded-[3rem] shadow-2xl p-10 text-center space-y-6"
                >
                    <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
                        <Check className="w-10 h-10" />
                    </div>
                    <h2 className="text-3xl font-bold text-gray-900">Booking Confirmed!</h2>
                    <p className="text-gray-500 max-w-xs mx-auto">
                        Your appointment with <span className="text-indigo-600 font-bold">{doctor.name}</span> has been successfully scheduled.
                    </p>

                    <div className="pt-6 space-y-3">
                        <Link
                            href="/dashboard/appointments"
                            className="block w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all active:scale-95 shadow-lg shadow-indigo-100"
                        >
                            View Appointments
                        </Link>
                        <button
                            onClick={onClose}
                            className="block w-full py-4 bg-gray-50 text-gray-600 rounded-2xl font-bold hover:bg-gray-100 transition-all"
                        >
                            Return Home
                        </button>
                    </div>
                </motion.div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={onClose}
                className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
            />
            <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="relative bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
                {/* Header Section */}
                <div className="p-6 md:p-8 border-b border-gray-50 shrink-0">
                    <div className="flex justify-between items-start mb-6">
                        <div className="flex gap-4 items-center">
                            <div className="w-12 h-12 rounded-xl overflow-hidden bg-indigo-50 border border-indigo-100 flex-shrink-0 relative">
                                <NextImage src={doctor.avatar} alt={doctor.name} fill className="object-cover" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-gray-900 leading-tight">{doctor.name}</h2>
                                <p className="text-indigo-600 text-xs font-bold uppercase tracking-widest">{doctor.specialty}</p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                        >
                            <X className="w-6 h-6 text-gray-400 hover:text-gray-600" />
                        </button>
                    </div>

                    {/* Progress Bar */}
                    <div className="flex items-center justify-between gap-2 max-w-sm mx-auto">
                        {steps.map((s, i) => (
                            <div key={s.id} className="flex-1 flex flex-col items-center gap-2">
                                <div className={cn(
                                    "h-1.5 w-full rounded-full transition-all duration-500",
                                    step >= s.id ? "bg-indigo-600" : "bg-gray-100"
                                )} />
                                <span className={cn(
                                    "text-[10px] font-bold uppercase tracking-widest transition-colors",
                                    step === s.id ? "text-indigo-600" : "text-gray-400"
                                )}>
                                    {s.name}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Body Content */}
                <div className="p-8 md:p-10 overflow-y-auto custom-scrollbar flex-1">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={step}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            transition={{ duration: 0.3 }}
                        >
                            {step === 1 && <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} />}
                            {step === 2 && <TimeSlots selectedTime={selectedTime} onChange={setSelectedTime} />}
                            {step === 3 && <PatientForm patientInfo={patientInfo} onChange={setPatientInfo} />}
                            {step === 4 && <BookingSummary doctor={doctor} date={selectedDate!} time={selectedTime!} patientInfo={patientInfo} />}
                        </motion.div>
                    </AnimatePresence>
                </div>

                {/* Footer Controls */}
                <div className="p-6 md:p-8 bg-gray-50/50 border-t border-gray-100 shrink-0">
                    <div className="flex items-center justify-between gap-6">
                        {step > 1 ? (
                            <button
                                onClick={prevStep}
                                className="flex items-center gap-2 text-gray-500 font-bold hover:text-indigo-600 transition-colors"
                            >
                                <ChevronLeft className="w-5 h-5" />
                                Back
                            </button>
                        ) : <div />}

                        <button
                            onClick={nextStep}
                            disabled={isNextDisabled() || isBooking}
                            className={cn(
                                "flex-1 md:flex-none md:min-w-[200px] py-4 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all active:scale-95 shadow-xl disabled:opacity-50 disabled:cursor-not-allowed",
                                step === 4 ? "bg-indigo-600 text-white shadow-indigo-100" : "bg-gray-900 text-white shadow-gray-200"
                            )}
                        >
                            {isBooking ? "Confirming..." : (
                                <>
                                    {step === 4 ? "Confirm & Schedule" : "Continue"}
                                    {step < 4 && <ChevronRight className="w-5 h-5" />}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
