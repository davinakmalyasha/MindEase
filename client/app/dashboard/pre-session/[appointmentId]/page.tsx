"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Sparkles, ArrowLeft, CheckCircle2, Loader2, MessageCircleQuestion } from "lucide-react";
import { useRouter } from "next/navigation";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Spinner from "@/components/ui/Spinner";
import AIDisclaimer from "@/components/ui/AIDisclaimer";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";

interface Answer {
    question: string;
    answer: string;
}

export default function PreSessionPage({ params }: { params: Promise<{ appointmentId: string }> }) {
    const router = useRouter();
    const { toast } = useToast();
    const [appointmentId, setAppointmentId] = useState<string>("");
    const [questions, setQuestions] = useState<string[]>([]);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [savedAnswers, setSavedAnswers] = useState<Answer[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        params.then(({ appointmentId }) => setAppointmentId(appointmentId));
    }, [params]);

    // Two distinct failures that the old code merged into one.
    //
    // The existence probe used to be `.catch(() => null)`, which turned *any*
    // error into "no questions exist yet" and therefore fell through to the
    // generating POST. A patient who had already answered their questions could
    // lose that work to one dropped connection, because the code that was asked
    // whether it existed never got an answer and answered for it.
    //
    // Only a 404 is evidence that nothing exists.
    const [loadFailed, setLoadFailed] = useState(false);

    const loadData = useCallback(async () => {
        if (!appointmentId) return;
        setIsLoading(true);
        setLoadFailed(false);
        try {
            let existing = null;
            try {
                const existingRes = await api.get(`/ai/pre-session/${appointmentId}`);
                existing = existingRes?.data?.data;
            } catch (err) {
                const status = (err as { response?: { status?: number } })?.response?.status;
                if (status !== 404) throw err;
            }

            if (existing?.questions?.length) {
                setQuestions(existing.questions);
                const saved = existing.answers || [];
                setSavedAnswers(saved);
                setAnswers(Object.fromEntries(saved.map((a: Answer) => [a.question, a.answer])));
            } else {
                const res = await api.post("/ai/pre-session", { appointmentId: Number(appointmentId) });
                setQuestions(res.data?.data?.questions || []);
                setAnswers({});
            }
        } catch (error) {
            console.error("[pre-session] load failed", error);
            toast(getErrorMessage(error, "Failed to load questions"), "error");
            setLoadFailed(true);
        } finally {
            setIsLoading(false);
        }
    }, [appointmentId, toast]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const allAnswered = questions.length > 0 && questions.every((q) => answers[q]?.trim());

    const submit = async () => {
        setIsSubmitting(true);
        try {
            const payload: Answer[] = questions.map((q) => ({ question: q, answer: answers[q]?.trim() || "" }));
            await api.post("/ai/pre-session/answers", { appointmentId: Number(appointmentId), answers: payload });
            toast("Reflections saved. Your doctor will see them before the session.", "success");
            setSavedAnswers(payload);
        } catch (error) {
            toast(getErrorMessage(error, "Failed to save answers"), "error");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <DashboardLayout>
            <button
                onClick={() => router.push("/dashboard/appointments")}
                className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold transition-all mb-6 group"
            >
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" /> Back to Appointments
            </button>

            <div className="mb-8">
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit flex items-center gap-3">
                    Pre-Session <span className="text-violet-600">Reflections</span>
                    <Sparkles className="w-8 h-8 text-violet-400" />
                </h1>
                <p className="text-gray-500 mt-2 max-w-xl">
                    Take a few quiet minutes to reflect before your session. Your answers help your doctor prepare
                    a better experience for you — and they stay private between you two.
                </p>
            </div>

            <div className="max-w-3xl mb-8">
                <AIDisclaimer />
            </div>

            {isLoading ? (
                <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-28 bg-white border border-gray-100 rounded-3xl animate-pulse" />
                    ))}
                </div>
            ) : loadFailed ? (
                <div role="alert" className="bg-white border border-rose-200 rounded-3xl py-16 px-8 text-center">
                    <MessageCircleQuestion className="w-12 h-12 text-rose-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-rose-800 mb-2">Could not load your questions</h3>
                    <p className="text-rose-700 max-w-sm mx-auto">
                        Any answers you have already given are still saved &mdash; this is a connection problem, not
                        a lost form.
                    </p>
                    <button
                        type="button"
                        onClick={loadData}
                        className="mt-6 px-6 py-3 bg-rose-600 text-white rounded-2xl font-bold hover:bg-rose-700 transition-all"
                    >
                        Try Again
                    </button>
                </div>
            ) : questions.length === 0 ? (
                <div className="bg-white border border-dashed border-gray-200 rounded-3xl py-16 text-center">
                    <MessageCircleQuestion className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-gray-900 mb-2">No Questions Yet</h3>
                    <p className="text-gray-500 max-w-sm mx-auto">
                        Questions are generated once your appointment is confirmed. Refresh if you just confirmed it.
                    </p>
                    <button onClick={loadData} className="mt-6 px-6 py-3 bg-violet-600 text-white rounded-2xl font-bold hover:bg-violet-700 transition-all">
                        Try Again
                    </button>
                </div>
            ) : (
                <div className="space-y-4 max-w-3xl">
                    {savedAnswers.length > 0 && savedAnswers.every((a) => a.answer) && (
                        <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-emerald-50 text-emerald-700 text-sm font-bold">
                            <CheckCircle2 className="w-4 h-4" /> You already submitted reflections — you can update them below.
                        </div>
                    )}
                    {questions.map((q, idx) => (
                        <motion.div
                            key={idx}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: idx * 0.05 }}
                            className="bg-white rounded-3xl border border-gray-100 p-6"
                        >
                            <p className="text-xs font-bold text-violet-500 uppercase tracking-widest mb-2">Question {idx + 1}</p>
                            <h3 className="font-extrabold text-gray-900 mb-3">{q}</h3>
                            <textarea
                                value={answers[q] || ""}
                                onChange={(e) => setAnswers((prev) => ({ ...prev, [q]: e.target.value }))}
                                rows={3}
                                placeholder="Share as much or as little as you feel comfortable..."
                                className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 text-sm font-medium resize-none"
                            />
                        </motion.div>
                    ))}
                    <div className="flex items-center justify-between pt-2 pb-10">
                        <p className={cn("text-xs font-bold", allAnswered ? "text-emerald-600" : "text-gray-400")}>
                            {allAnswered ? "✓ All questions answered" : `Answer all questions to enable submission (${Object.values(answers).filter((a) => a?.trim()).length}/${questions.length})`}
                        </p>
                        <button
                            onClick={submit}
                            disabled={!allAnswered || isSubmitting}
                            className="px-8 py-3.5 bg-violet-600 text-white rounded-2xl font-bold hover:bg-violet-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-violet-200"
                        >
                            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            Save Reflections
                        </button>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}
