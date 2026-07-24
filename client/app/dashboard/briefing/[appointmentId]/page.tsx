"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Sparkles, ArrowLeft, Brain, FileText, Loader2, AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import DashboardLayout from "@/components/layout/DashboardLayout";
import MoodChart from "@/components/mood/MoodChart";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export default function BriefingPage({ params }: { params: Promise<{ appointmentId: string }> }) {
    const router = useRouter();
    const { toast } = useToast();
    const [appointmentId, setAppointmentId] = useState("");
    const [briefing, setBriefing] = useState<string | null>(null);
    const [moodHistory, setMoodHistory] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isGenerating, setIsGenerating] = useState(false);
    const [appointment, setAppointment] = useState<any>(null);

    useEffect(() => {
        params.then(({ appointmentId }) => setAppointmentId(appointmentId));
    }, [params]);

    const generate = useCallback(async (force = false) => {
        if (!appointmentId) return;
        setIsGenerating(true);
        try {
            const res = force
                ? await api.post("/ai/briefing", { appointmentId: Number(appointmentId) })
                : await api.get(`/ai/briefing/${appointmentId}`);
            setBriefing(res.data?.data?.briefing || null);
            if (Array.isArray(res.data?.data?.moodHistory)) {
                setMoodHistory(res.data.data.moodHistory);
            }
        } catch (error) {
            toast(getErrorMessage(error, "Failed to generate briefing"), "error");
        } finally {
            setIsGenerating(false);
            setIsLoading(false);
        }
    }, [appointmentId, toast]);

    useEffect(() => {
        if (!appointmentId) return;
        // Try cached first, then generate
        api.get(`/ai/briefing/${appointmentId}`)
            .then((res) => {
                setBriefing(res.data?.data?.briefing || null);
                if (Array.isArray(res.data?.data?.moodHistory)) {
                    setMoodHistory(res.data.data.moodHistory);
                }
                setIsLoading(false);
            })
            .catch(() => generate(true));
    }, [appointmentId, generate]);

    // Fetch appointment context (patient info + mood history comes with briefing via answers)
    useEffect(() => {
        if (!appointmentId) return;
        api.get("/appointments/my")
            .then((res) => {
                const found = (res.data?.data || []).find((a: any) => String(a.id) === appointmentId);
                setAppointment(found || null);
            })
            .catch(() => {});
    }, [appointmentId]);

    return (
        <DashboardLayout>
            <button
                onClick={() => router.push("/dashboard/appointments")}
                className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold transition-all mb-6 group"
            >
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" /> Back to Appointments
            </button>

            <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-4xl font-extrabold text-gray-900 font-outfit flex items-center gap-3">
                        Clinical <span className="text-violet-600">Briefing</span>
                        <Brain className="w-8 h-8 text-violet-400" />
                    </h1>
                    <p className="text-gray-500 mt-2 max-w-xl">
                        An AI-compiled summary of the patient&apos;s recent mood and pre-session reflections —
                        generated from Gemini and only visible to you.
                    </p>
                </div>
                {appointment?.user?.name && (
                    <div className="bg-white border border-gray-100 rounded-2xl px-5 py-3">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Patient</p>
                        <p className="font-extrabold text-gray-900">{appointment.user.name}</p>
                        <p className="text-xs text-gray-400">{new Date(appointment.appointmentDate).toLocaleDateString("en-GB")} · {appointment.startTime}</p>
                    </div>
                )}
            </div>

            {isLoading ? (
                <div className="h-64 bg-white border border-gray-100 rounded-3xl animate-pulse" />
            ) : (
                <div className="grid lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2">
                        <div className="bg-white rounded-3xl border border-gray-100 p-8">
                            <div className="flex items-center justify-between mb-6">
                                <h2 className="text-lg font-extrabold text-gray-900 flex items-center gap-2">
                                    <FileText className="w-5 h-5 text-violet-500" /> Briefing
                                </h2>
                                <button
                                    onClick={() => generate(true)}
                                    disabled={isGenerating}
                                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 transition-all disabled:opacity-50"
                                >
                                    {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                    Regenerate
                                </button>
                            </div>

                            {briefing ? (
                                <motion.p
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="text-gray-700 leading-relaxed text-lg font-medium bg-violet-50/40 rounded-2xl p-6 border border-violet-100/50"
                                >
                                    {briefing}
                                </motion.p>
                            ) : (
                                <div className="flex flex-col items-center py-12 text-center">
                                    <AlertCircle className="w-10 h-10 text-amber-400 mb-4" />
                                    <p className="text-gray-500 font-medium mb-4">No briefing available yet.</p>
                                    <button
                                        onClick={() => generate(true)}
                                        disabled={isGenerating}
                                        className="px-6 py-3 bg-violet-600 text-white rounded-2xl font-bold hover:bg-violet-700 transition-all flex items-center gap-2"
                                    >
                                        {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                        Generate Briefing
                                    </button>
                                </div>
                            )}

                            <p className="text-[10px] text-gray-400 italic mt-4">
                                * Briefings are generated from the patient&apos;s last 14 days of mood entries and their pre-session answers.
                            </p>
                        </div>
                    </div>

                    <div className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-6">Patient Mood (14 days)</h2>
                        {moodHistory.length > 0 ? (
                            <MoodChart entries={moodHistory} />
                        ) : (
                            <p className="text-sm text-gray-400 text-center py-10">No mood data available for this patient.</p>
                        )}
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}
