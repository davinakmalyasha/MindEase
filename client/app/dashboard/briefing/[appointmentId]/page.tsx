"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Sparkles, ArrowLeft, Brain, FileText, Loader2, AlertCircle, ClipboardCheck, RefreshCw, ListChecks, MessageSquareText, Stethoscope } from "lucide-react";
import { useRouter } from "next/navigation";
import DashboardLayout from "@/components/layout/DashboardLayout";
import MoodChart from "@/components/mood/MoodChart";
import AIDisclaimer from "@/components/ui/AIDisclaimer";
import AiSourceBadge, { type AiSource } from "@/components/ui/AiSourceBadge";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { severityLabel } from "@/lib/data/assessments";

const SEVERITY_STYLES: Record<string, string> = {
    minimal: "bg-emerald-50 text-emerald-700 border-emerald-200",
    mild: "bg-lime-50 text-lime-700 border-lime-200",
    moderate: "bg-amber-50 text-amber-700 border-amber-200",
    "moderately-severe": "bg-orange-50 text-orange-700 border-orange-200",
    severe: "bg-rose-50 text-rose-700 border-rose-200",
};

export default function BriefingPage({ params }: { params: Promise<{ appointmentId: string }> }) {
    const router = useRouter();
    const { toast } = useToast();
    const [appointmentId, setAppointmentId] = useState("");
    const [briefing, setBriefing] = useState<string | null>(null);
    const [briefingSource, setBriefingSource] = useState<AiSource | undefined>(undefined);
    // Grounding the API now attaches: which rows the synthesis stands on, whether
    // the record is too thin to synthesise from, why a fallback was served, the
    // pre-session answers behind the "pre-session" citation, and cache state.
    const [sources, setSources] = useState<any[]>([]);
    const [insufficientData, setInsufficientData] = useState(false);
    const [degradedReason, setDegradedReason] = useState<string | undefined>(undefined);
    const [answers, setAnswers] = useState<any[]>([]);
    const [cached, setCached] = useState<boolean | undefined>(undefined);
    // Copilot drafts are ephemeral and live beside the briefing, never inside it:
    // a draft is generated, read, and forgotten, so it gets its own panel and
    // its own sources rather than sharing the briefing's.
    const [copilot, setCopilot] = useState<string | null>(null);
    const [copilotSources, setCopilotSources] = useState<any[]>([]);
    const [copilotInsufficient, setCopilotInsufficient] = useState(false);
    const [isCopilotLoading, setIsCopilotLoading] = useState(false);
    const [copilotFailed, setCopilotFailed] = useState(false);
    const [moodHistory, setMoodHistory] = useState<any[]>([]);
    const [assessments, setAssessments] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isGenerating, setIsGenerating] = useState(false);
    const [appointment, setAppointment] = useState<any>(null);

    // `briefing === null` has two very different causes, and the page used to
    // render them identically: "there is no briefing for this appointment" and
    // "we could not reach the server to find out". Both produced the sentence
    // "No briefing available yet", which is a claim about the world and was
    // simply false in the second case. A toast said something had gone wrong and
    // then vanished, leaving the false claim on screen as the durable state.
    const [loadFailed, setLoadFailed] = useState(false);

    // Monotonic request counter; see the effect below.
    const requestSeq = useRef(0);

    // Abandoned work on unmount increments the counter, so any in-flight response
    // finds itself stale and declines to write.
    useEffect(() => {
        params.then(({ appointmentId }) => setAppointmentId(appointmentId));
        return () => {
            requestSeq.current += 1;
        };
    }, [params]);

    const applyData = (data: any) => {
        setBriefing(data?.briefing || null);
        setLoadFailed(false);
        // Read from the server rather than sniffing the text: the API stores the
        // origin alongside the briefing, so this is still correct when reading a
        // briefing generated days ago.
        setBriefingSource(data?.ai?.source);
        setDegradedReason(data?.ai?.degradedReason);
        if (Array.isArray(data?.moodHistory)) setMoodHistory(data.moodHistory);
        if (Array.isArray(data?.assessments)) setAssessments(data.assessments);
        if (Array.isArray(data?.sources)) setSources(data.sources);
        setInsufficientData(data?.insufficientData === true);
        if (Array.isArray(data?.answers)) setAnswers(data.answers);
        if (typeof data?.cached === "boolean") setCached(data.cached);
    };

    const draftCopilot = useCallback(async () => {
        if (!appointmentId) return;
        const seq = ++requestSeq.current;
        setIsCopilotLoading(true);
        setCopilotFailed(false);
        try {
            const res = await api.post("/ai/copilot-draft", { appointmentId });
            if (seq !== requestSeq.current) return;
            const data = res.data?.data;
            setCopilot(data?.draft || null);
            if (Array.isArray(data?.sources)) setCopilotSources(data.sources);
            setCopilotInsufficient(data?.insufficientData === true);
        } catch (error) {
            if (seq !== requestSeq.current) return;
            console.error("[briefing] copilot draft failed", error);
            toast(getErrorMessage(error, "Failed to draft session prep"), "error");
            setCopilotFailed(true);
        } finally {
            setIsCopilotLoading(false);
        }
    }, [appointmentId, toast]);

    const generate = useCallback(async (force = false) => {
        if (!appointmentId) return;
        const seq = ++requestSeq.current;
        setIsGenerating(true);
        try {
            const res = force
                ? await api.post("/ai/briefing", { appointmentId })
                : await api.get(`/ai/briefing/${appointmentId}`);
            // A generation can take seconds. If the user navigated to another
            // appointment in the meantime, writing now would replace this
            // clinician's briefing with the other patient's.
            if (seq !== requestSeq.current) return;
            applyData(res.data?.data);
        } catch (error) {
            if (seq !== requestSeq.current) return;
            console.error("[briefing] generate failed", error);
            toast(getErrorMessage(error, "Failed to generate briefing"), "error");
            // A generation that failed leaves the panel showing whatever it
            // showed before, which if that was `null` is the "No briefing
            // available yet" claim again. Same false statement, one layer down.
            setLoadFailed(true);
        } finally {
            setIsGenerating(false);
            setIsLoading(false);
        }
    }, [appointmentId, toast]);

    useEffect(() => {
        if (!appointmentId) return;

        // Two requests can be in flight for the same component: this GET and a
        // `generate` the 404 path below kicks off, or a regenerate the user
        // pressed. `params` resolves asynchronously, so on a client-side
        // navigation the component stays mounted while `appointmentId` changes,
        // and the first response can land last and overwrite the second
        // appointment's briefing with the previous patient's - on the screen of
        // a clinician about to read it. A sequence number makes the newest
        // request the only one allowed to write.
        const seq = ++requestSeq.current;

        // Try cached first, then generate
        api.get(`/ai/briefing/${appointmentId}`)
            .then((res) => {
                if (seq !== requestSeq.current) return;
                applyData(res.data?.data);
                setIsLoading(false);
            })
            .catch((err: unknown) => {
                if (seq !== requestSeq.current) return;
                // Not every failure means "there is no briefing yet".
                //
                // This used to be `.catch(() => generate(true))`, so any error -
                // a dropped connection, a 502, a 401 - was treated as proof that
                // no briefing existed, and answered by paying for an LLM call to
                // create one. A network blip therefore cost money and produced a
                // briefing for a patient who already had one.
                //
                // Only a 404 is evidence of absence. Everything else is
                // "unknown", and gets a retry rather than a regeneration.
                const status = (err as { response?: { status?: number } })?.response?.status;
                console.error("[briefing] load failed", err);
                setIsLoading(false);
                if (status === 404) {
                    generate(true);
                } else {
                    setLoadFailed(true);
                }
            });
    }, [appointmentId, generate]);

    const reload = useCallback(() => {
        if (!appointmentId) return;
        const seq = ++requestSeq.current;
        setIsLoading(true);
        setLoadFailed(false);
        api.get(`/ai/briefing/${appointmentId}`)
            .then((res) => {
                if (seq !== requestSeq.current) return;
                applyData(res.data?.data);
                setIsLoading(false);
            })
            .catch((err: unknown) => {
                if (seq !== requestSeq.current) return;
                console.error("[briefing] reload failed", err);
                setIsLoading(false);
                setLoadFailed(true);
            });
    }, [appointmentId]);

    // Supplementary context: the patient name and appointment time in the header.
    // The briefing itself does not depend on it, so a failure here degrades the
    // header rather than the page - but it is logged rather than swallowed, so
    // the header disappearing is a diagnosable event and not a mystery.
    useEffect(() => {
        if (!appointmentId) return;
        const seq = ++requestSeq.current;
        api.get("/appointments/my")
            .then((res) => {
                if (seq !== requestSeq.current) return;
                const found = (res.data?.data || []).find((a: any) => String(a.id) === appointmentId);
                setAppointment(found || null);
            })
            .catch((err: unknown) => {
                if (seq !== requestSeq.current) return;
                console.error("[briefing] appointment context failed", err);
            });
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
                        An AI-generated summary of the patient&apos;s recent mood and pre-session reflections —
                        compiled from their records and only visible to you.
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
                                <div className="rounded-2xl bg-violet-50/40 border border-violet-100/50">
                                    <div className="px-6 pt-5 flex items-center gap-3 flex-wrap">
                                        <AiSourceBadge source={briefingSource} />
                                        {typeof cached === "boolean" && (
                                            <span className="text-[11px] font-bold text-gray-400">
                                                {cached ? "Saved briefing" : "Just generated"}
                                            </span>
                                        )}
                                        {briefingSource !== "model" && degradedReason && (
                                            <span className="text-[11px] font-medium text-gray-400">
                                                Reason: {degradedReason}
                                            </span>
                                        )}
                                    </div>
                                    {insufficientData && (
                                        <div className="mx-6 mt-4 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
                                            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                                            <p className="text-sm text-amber-800 font-medium">
                                                Limited data — this patient has no recent moods, screening scores or
                                                pre-session answers, so there is nothing to synthesise yet. The text
                                                below is a placeholder, not a summary.
                                            </p>
                                        </div>
                                    )}
                                    <motion.p
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        className="text-gray-700 leading-relaxed text-lg font-medium p-6 pt-4"
                                    >
                                        {briefing}
                                    </motion.p>
                                    {sources.length > 0 && (
                                        <div className="mx-6 mb-5 rounded-xl bg-white border border-violet-100 px-4 py-3">
                                            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                                                <ListChecks className="w-3.5 h-3.5" /> Grounded in {sources.length} record{sources.length === 1 ? "" : "s"}
                                            </p>
                                            <ul className="space-y-1">
                                                {sources.map((s: any, i: number) => (
                                                    <li key={`${s.kind}-${s.id || i}`} className="text-sm text-gray-600 font-medium">
                                                        <span className="inline-block min-w-24 text-[11px] font-bold uppercase text-violet-500 mr-2">{s.kind}</span>
                                                        {s.label}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            ) : loadFailed ? (
                                // Unknown, not empty. The panel says so rather
                                // than asserting there is nothing here.
                                <div className="flex flex-col items-center py-12 text-center">
                                    <AlertCircle className="w-10 h-10 text-rose-400 mb-4" />
                                    <p className="text-gray-700 font-semibold mb-1">
                                        Could not load this briefing
                                    </p>
                                    <p className="text-gray-500 text-sm mb-4">
                                        It may already exist &mdash; this is a connection problem, not an
                                        absence.
                                    </p>
                                    <button
                                        onClick={reload}
                                        disabled={isGenerating}
                                        className="px-6 py-3 bg-rose-600 text-white rounded-2xl font-bold hover:bg-rose-700 transition-all flex items-center gap-2"
                                    >
                                        {isGenerating ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <RefreshCw className="w-4 h-4" />
                                        )}
                                        Retry
                                    </button>
                                </div>
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
                            <div className="mt-6">
                                <AIDisclaimer compact />
                            </div>
                        </div>

                        {answers.length > 0 && (
                            <div className="bg-white rounded-3xl border border-gray-100 p-8 mt-6">
                                <h2 className="text-lg font-extrabold text-gray-900 flex items-center gap-2 mb-5">
                                    <MessageSquareText className="w-5 h-5 text-teal-500" /> Pre-session answers
                                </h2>
                                <div className="space-y-4">
                                    {answers.map((a: any, i: number) => (
                                        <div key={i} className="rounded-2xl bg-gray-50 p-4">
                                            <p className="text-sm font-bold text-gray-900 mb-1">{a.question}</p>
                                            <p className="text-sm text-gray-600 font-medium">{a.answer}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="bg-white rounded-3xl border border-gray-100 p-8 mt-6">
                            <div className="flex items-center justify-between mb-2">
                                <h2 className="text-lg font-extrabold text-gray-900 flex items-center gap-2">
                                    <Stethoscope className="w-5 h-5 text-teal-500" /> Session prep draft
                                </h2>
                                <button
                                    onClick={draftCopilot}
                                    disabled={isCopilotLoading}
                                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-teal-500 text-white text-sm font-bold hover:bg-teal-600 transition-all disabled:opacity-50"
                                >
                                    {isCopilotLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                    {copilot ? "Re-draft" : "Draft prep notes"}
                                </button>
                            </div>
                            <p className="text-xs text-gray-400 font-medium mb-4">
                                Advisory bullets for you only — never a diagnosis, plan or verdict. Drafts are generated on demand and never stored.
                            </p>
                            {copilot ? (
                                <div className="rounded-2xl bg-teal-50/50 border border-teal-100/60 p-6">
                                    {copilotInsufficient && (
                                        <p className="text-sm text-amber-700 font-semibold mb-3">
                                            Limited data — review the record directly before the session.
                                        </p>
                                    )}
                                    <p className="text-gray-700 leading-relaxed font-medium whitespace-pre-line">{copilot}</p>
                                    {copilotSources.length > 0 && (
                                        <p className="text-[11px] text-gray-400 font-medium mt-3">
                                            Grounded in {copilotSources.length} record{copilotSources.length === 1 ? "" : "s"}:{" "}
                                            {copilotSources.map((s: any) => s.label).join(" · ")}
                                        </p>
                                    )}
                                </div>
                            ) : copilotFailed ? (
                                <div className="flex flex-col items-center py-8 text-center">
                                    <AlertCircle className="w-8 h-8 text-rose-400 mb-3" />
                                    <p className="text-gray-500 text-sm font-medium mb-4">Could not draft prep notes.</p>
                                    <button
                                        onClick={draftCopilot}
                                        disabled={isCopilotLoading}
                                        className="px-5 py-2.5 bg-teal-600 text-white rounded-2xl text-sm font-bold hover:bg-teal-700 transition-all flex items-center gap-2"
                                    >
                                        <RefreshCw className="w-4 h-4" /> Retry
                                    </button>
                                </div>
                            ) : (
                                <p className="text-sm text-gray-400 text-center py-8">
                                    {isCopilotLoading ? "Drafting from the patient record…" : "No draft yet. Generate one when you start preparing."}
                                </p>
                            )}
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

                    <div className="bg-white rounded-3xl border border-gray-100 p-6 mt-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-5 flex items-center gap-2">
                            <ClipboardCheck className="w-5 h-5 text-teal-500" /> Screening Scores
                        </h2>
                        {assessments.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-8">No PHQ-9 / GAD-7 results on record.</p>
                        ) : (
                            <div className="space-y-3">
                                {assessments.map((a: any) => (
                                    <div key={a.type} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl">
                                        <div>
                                            <p className="text-sm font-black text-gray-900 uppercase">{a.type === "phq9" ? "PHQ-9" : "GAD-7"}</p>
                                            <p className="text-[11px] text-gray-400 font-medium">
                                                {new Date(a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="text-xl font-black text-gray-900">{a.score}</span>
                                            <span className={cn("px-3 py-1 rounded-full text-[11px] font-bold border capitalize", SEVERITY_STYLES[a.severity])}>
                                                {severityLabel(a.type, a.severity)}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}
