"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Siren, MessageCircle, X } from "lucide-react";
import Link from "next/link";

interface SOSAlert {
    patientName?: string;
    patientId?: number;
}

/**
 * Urgent full-screen alert shown to doctors when a patient presses SOS.
 * Triggered via the `realtime:sos-alert` window event from the WebSocket hook.
 */
export default function SOSAlertModal() {
    const [alerts, setAlerts] = useState<SOSAlert[]>([]);

    useEffect(() => {
        const handler = (e: Event) => {
            setAlerts((prev) => [...prev.slice(-2), (e as CustomEvent).detail || {}]);
        };
        window.addEventListener("realtime:sos-alert", handler);
        return () => window.removeEventListener("realtime:sos-alert", handler);
    }, []);

    const current = alerts[0];
    if (!current) return null;
    const dismiss = () => setAlerts((prev) => prev.slice(1));

    return (
        <AnimatePresence>
            {current && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] bg-rose-950/70 backdrop-blur-md flex items-center justify-center p-4"
                >
                    <motion.div
                        initial={{ scale: 0.85, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.85, opacity: 0 }}
                        className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl border-4 border-rose-500"
                        role="alertdialog"
                        aria-live="assertive"
                    >
                        <div className="flex items-start justify-between mb-5">
                            <div className="flex items-center gap-3">
                                <div className="w-12 h-12 rounded-2xl bg-rose-500 text-white flex items-center justify-center animate-pulse shadow-lg shadow-rose-200">
                                    <Siren className="w-6 h-6" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-black text-gray-900">SOS Alert</h3>
                                    <p className="text-xs font-bold uppercase tracking-widest text-rose-500">
                                        A patient needs support now
                                    </p>
                                </div>
                            </div>
                            <button onClick={dismiss} aria-label="Dismiss" className="text-gray-300 hover:text-gray-500 transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <p className="text-sm font-semibold text-gray-700 leading-relaxed mb-6">
                            <span className="font-black">{current.patientName || "A patient"}</span> pressed the SOS
                            panic button and needs support. Please check in with them as soon as possible.
                        </p>

                        <div className="flex gap-3">
                            <Link
                                href="/messages"
                                onClick={dismiss}
                                className="flex-1 py-3 bg-rose-500 text-white rounded-2xl font-black text-sm flex items-center justify-center gap-2 hover:bg-rose-600 transition-all"
                            >
                                <MessageCircle className="w-4 h-4" /> Open chat
                            </Link>
                            <button
                                onClick={dismiss}
                                className="px-5 py-3 rounded-2xl font-bold text-sm text-gray-500 hover:bg-gray-50 transition-all"
                            >
                                Dismiss
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
