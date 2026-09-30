"use client";

import { Suspense, useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ClipboardCheck, ShieldAlert, ChevronLeft, ChevronRight, CheckCircle2, Printer } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Spinner from "@/components/ui/Spinner";
import AIDisclaimer from "@/components/ui/AIDisclaimer";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import { ASSESSMENTS, OPTION_LABELS, severityLabel } from "@/lib/data/assessments";
import { useAssessments, useSubmitAssessment } from "@/hooks/queries/useMoodQuery";

const SEVERITY_STYLES: Record<string, string> = {
    minimal: "bg-emerald-50 text-emerald-700 border-emerald-200",
    mild: "bg-lime-50 text-lime-700 border-lime-200",
    moderate: "bg-amber-50 text-amber-700 border-amber-200",
    "moderately-severe": "bg-orange-50 text-orange-700 border-orange-200",
    severe: "bg-rose-50 text-rose-700 border-rose-200",
};

export default function AssessmentsPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
            <AssessmentsContent />
        </Suspense>
    );
}

function PrintableReport() {
    const { data: phq9 = [] } = useAssessments("phq9", 50);
    const { data: gad7 = [] } = useAssessments("gad7", 50);

    useEffect(() => {
        const t = setTimeout(() => window.print(), 500);
        return () => clearTimeout(t);
    }, []);

    const renderTable = (rows: any[], type: "phq9" | "gad7") => (
        <table className="w-full text-sm mb-8">
            <thead>
                <tr className="text-left border-b-2 border-gray-800">
                    <th className="py-2">Date</th>
                    <th className="py-2">Score / {type === "phq9" ? 27 : 21}</th>
                    <th className="py-2">Severity</th>
                </tr>
            </thead>
            <tbody>
                {rows.length === 0 ? (
                    <tr><td colSpan={3} className="py-2 text-gray-400">No results.</td></tr>
                ) : rows.map((r) => (
                    <tr key={r.id} className="border-b border-gray-200">
                        <td className="py-2">{new Date(r.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</td>
                        <td className="py-2 font-bold">{r.score}</td>
                        <td className="py-2 capitalize">{severityLabel(type, r.severity)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );

    return (
        <main className="max-w-2xl mx-auto p-8">
            <div className="flex items-center justify-between mb-6 print:hidden">
                <button
                    onClick={() => window.print()}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-teal-500 text-white text-sm font-bold hover:bg-teal-600"
                >
                    <Printer className="w-4 h-4" /> Print / Save PDF
                </button>
                <a href="/dashboard/assessments" className="text-sm font-bold text-gray-500 hover:text-gray-700">Back</a>
            </div>
            <h1 className="text-2xl font-black text-gray-900 mb-1">MindEase Assessment Report</h1>
            <p className="text-xs text-gray-500 mb-6">Patient Health Questionnaire (PHQ-9) & Generalized Anxiety Disorder (GAD-7) history. Screening tools are indicators, not diagnoses.</p>
            <h2 className="text-lg font-bold text-gray-900 mb-3">PHQ-9 (Depression)</h2>
            {renderTable(phq9, "phq9")}
            <h2 className="text-lg font-bold text-gray-900 mb-3">GAD-7 (Anxiety)</h2>
            {renderTable(gad7, "gad7")}
            <p className="text-[10px] text-gray-400 mt-8">Generated {new Date().toLocaleDateString("en-GB")} · MindEase platform</p>
        </main>
    );
}

function AssessmentsContent() {
    const t = useTranslations("features.assessments");
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const [activeType, setActiveType] = useState<"phq9" | "gad7">("phq9");
    const [step, setStep] = useState(0);
    const [answers, setAnswers] = useState<number[]>([]);
    const [result, setResult] = useState<any>(null);

    const { data: history = [], isLoading } = useAssessments(activeType, 10);
    const submit = useSubmitAssessment();

    if (searchParams.get("print") === "1") {
        return <PrintableReport />;
    }

    const meta = ASSESSMENTS[activeType];
    const isLast = step === meta.questions.length - 1;

    const choose = (value: number) => {
        const next = [...answers];
        next[step] = value;
        setAnswers(next);
    };

    const next = () => {
        if (!isLast) {
            setStep((s) => s + 1);
        } else {
            submit.mutate(
                { type: activeType, answers },
                {
                    onSuccess: (data) => {
                        setResult(data);
                        setAnswers([]);
                        setStep(0);
                    },
                }
            );
        }
    };

    const startOver = () => {
        setResult(null);
        setAnswers([]);
        setStep(0);
    };

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    return (
        <DashboardLayout>
            <div className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                    <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">
                        Self-<span className="text-teal-500">Assessments</span>
                    </h1>
                    <p className="text-gray-500 mt-2">{t("subtitle")}</p>
                </div>
                <button
                    onClick={() => window.open("/dashboard/assessments?print=1", "_blank")}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white border border-gray-100 text-gray-600 text-sm font-bold hover:bg-teal-50 hover:text-teal-600 hover:border-teal-100 transition-all"
                >
                    <Printer className="w-4 h-4" /> Print / PDF Report
                </button>
            </div>

            <div className="grid lg:grid-cols-5 gap-6">
                {/* Questionnaire */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="lg:col-span-3 bg-white rounded-3xl border border-gray-100 p-6">
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-lg font-extrabold text-gray-900 flex items-center gap-2">
                            <ClipboardCheck className="w-5 h-5 text-teal-500" /> {meta.name} Screening
                        </h2>
                        <div className="flex gap-2">
                            {(Object.keys(ASSESSMENTS) as ("phq9" | "gad7")[]).map((t) => (
                                <button
                                    key={t}
                                    onClick={() => {
                                        setActiveType(t);
                                        setStep(0);
                                        setAnswers([]);
                                        setResult(null);
                                    }}
                                    className={cn(
                                        "px-4 py-1.5 rounded-xl text-sm font-bold transition-all",
                                        activeType === t ? "bg-teal-500 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                                    )}
                                >
                                    {ASSESSMENTS[t].name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {result ? (
                        <div className="text-center py-10">
                            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
                            <h3 className="text-2xl font-black text-gray-900 mb-1">{result.score} / {meta.maxScore}</h3>
                            <span className={cn("inline-block px-4 py-1.5 rounded-full text-sm font-bold border", SEVERITY_STYLES[result.severity])}>
                                {severityLabel(activeType, result.severity)}
                            </span>
                            <p className="text-sm text-gray-500 mt-4 max-w-md mx-auto">
                                {result.severity === "severe" || result.severity === "moderately-severe"
                                    ? t("severeHint")
                                    : t("savedHint")}
                            </p>
                            <button onClick={startOver} className="mt-6 px-6 py-2.5 rounded-xl bg-teal-500 text-white text-sm font-bold hover:bg-teal-600 transition-all">
                                {t("takeAgain")}
                            </button>
                        </div>
                    ) : (
                        <>
                            <p className="text-sm text-gray-500 text-center mb-6">{t("questionHint")}</p>
                            <div className="space-y-5">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm font-bold text-gray-500">Question {step + 1} of {meta.questions.length}</p>
                                    <div className="flex gap-1">
                                        {meta.questions.map((_, i) => (
                                            <span key={i} className={cn("w-6 h-1.5 rounded-full transition-colors", i <= step ? "bg-teal-500" : "bg-gray-100")} />
                                        ))}
                                    </div>
                                </div>
                                <motion.div key={step} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="bg-gray-50 rounded-2xl p-6">
                                    <p className="text-base font-bold text-gray-900 mb-5 leading-relaxed">{meta.questions[step].text}</p>
                                    <div className="space-y-2">
                                        {OPTION_LABELS.map((label, i) => (
                                            <button
                                                key={label}
                                                onClick={() => choose(i)}
                                                className={cn(
                                                    "w-full text-left px-4 py-3 rounded-xl border-2 text-sm font-semibold transition-all",
                                                    answers[step] === i
                                                        ? "border-teal-400 bg-teal-50 text-teal-700"
                                                        : "border-gray-100 bg-white text-gray-600 hover:border-teal-100"
                                                )}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </motion.div>
                            </div>
                            <div className="flex items-center justify-between mt-6">
                                <button
                                    onClick={() => setStep((s) => Math.max(0, s - 1))}
                                    disabled={step === 0}
                                    className="flex items-center gap-1 px-4 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-100 transition-all disabled:opacity-40"
                                >
                                    <ChevronLeft className="w-4 h-4" /> {t("back")}
                                </button>
                                <button
                                    onClick={next}
                                    disabled={answers[step] === undefined || submit.isPending}
                                    className="flex items-center gap-1 px-6 py-2.5 rounded-xl bg-teal-500 text-white text-sm font-bold hover:bg-teal-600 transition-all disabled:opacity-50"
                                >
                                    {submit.isPending ? <Spinner size="sm" className="text-white" /> : isLast ? t("submit") : t("next")}
                                    {!submit.isPending && isLast && <CheckCircle2 className="w-4 h-4" />}
                                    {!submit.isPending && !isLast && <ChevronRight className="w-4 h-4" />}
                                </button>
                            </div>
                        </>
                    )}
                    <div className="mt-6">
                        <AIDisclaimer />
                    </div>
                </motion.div>

                {/* History */}
                <div className="lg:col-span-2 space-y-4">
                    <div className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h3 className="font-extrabold text-gray-900 mb-4 flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4 text-amber-500" /> {meta.name} {t("history")}
                        </h3>
                        {isLoading ? (
                            <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-14 bg-gray-50 rounded-2xl animate-pulse" />)}</div>
                        ) : history.length === 0 ? (
                            <p className="text-sm text-gray-400">{t("historyEmpty")}</p>
                        ) : (
                            <div className="space-y-3">
                                {history.map((h) => (
                                    <div key={h.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl">
                                        <div>
                                            <p className="text-sm font-black text-gray-900">{h.score} <span className="text-xs font-bold text-gray-400">/ {meta.maxScore}</span></p>
                                            <p className="text-[11px] text-gray-400 font-medium">
                                                {new Date(h.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                                            </p>
                                        </div>
                                        <span className={cn("px-3 py-1 rounded-full text-[11px] font-bold border", SEVERITY_STYLES[h.severity])}>
                                            {severityLabel(activeType, h.severity)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <p className="text-[11px] text-gray-400 leading-relaxed px-2">
                        {t("disclaimer")}
                    </p>
                </div>
            </div>
        </DashboardLayout>
    );
}
