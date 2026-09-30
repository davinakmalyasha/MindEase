"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ShieldAlert, Loader2, Check, CircleCheck, Clock } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import {
    useRiskQueue,
    useAcknowledgeRisk,
    useResolveRisk,
    useRiskAlertListener,
    SOURCE_LABEL,
} from "@/hooks/queries/useRiskQueueQuery";
import { useToast } from "@/components/ui/Toast";

/**
 * The clinician triage queue.
 *
 * This is the surface that makes a safety signal actionable. Every other part
 * of the product is reactive to it: PHQ-9 item 9, the SOS button, and a crisis
 * phrase in a message all end up here, and `realtime:risk-alert` lands here too.
 *
 * Two things are deliberately not in this file:
 *
 *  - No auto-escalation. Nothing here contacts an emergency service. The queue
 *    exists so a human decides, because a false positive that pages a hospital
 *    is its own harm.
 *  - No "dismiss". An alert is acknowledged or resolved, never dismissed. The
 *    row stays in the database either way, because "we raised this and dealt
 *    with it" is the record a clinician needs when the patient returns.
 */
export default function RiskQueuePage() {
    const t = useTranslations("features.riskQueue");
    const { toast } = useToast();
    const [includeResolved, setIncludeResolved] = useState(false);
    const [resolving, setResolving] = useState<number | null>(null);
    const [note, setNote] = useState("");

    const { data, isLoading } = useRiskQueue(includeResolved);
    const acknowledge = useAcknowledgeRisk();
    const resolve = useResolveRisk();

    useRiskAlertListener((payload) => {
        const level = (payload as { level?: string } | null)?.level;
        // "error" rather than a warning variant: this is an alert arriving, not
        // a failure, and the toast has no warning tone. The queue itself is the
        // signal; this is a nudge.
        toast(level === "urgent" ? t("newUrgent") : t("newAlert"), "info");
    });

    const items = data?.items ?? [];
    const counts = data?.counts;

    const onResolve = async (id: number) => {
        try {
            await resolve.mutateAsync({ id, note: note.trim() || undefined });
            setNote("");
            setResolving(null);
            toast(t("resolvedToast"), "success");
        } catch (err) {
            toast(t("actionFailed"), "error");
        }
    };

    return (
        <DashboardLayout>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-extrabold text-gray-900">
                        <ShieldAlert className="h-6 w-6 text-rose-500" />
                        {t("title")}
                    </h1>
                    <p className="mt-1 text-sm text-gray-500">{t("intro")}</p>
                </div>
                <label className="flex items-center gap-2 text-xs font-bold text-gray-500">
                    <input
                        type="checkbox"
                        checked={includeResolved}
                        onChange={(e) => setIncludeResolved(e.target.checked)}
                    />
                    {t("includeResolved")}
                </label>
            </div>

            {counts && (
                <div className="mb-6 grid grid-cols-3 gap-3">
                    <Stat
                        label={t("statUnresolved")}
                        value={counts.unresolved}
                        tone={counts.unresolved > 0 ? "rose" : "slate"}
                    />
                    <Stat
                        label={t("statUnacknowledged")}
                        value={counts.unacknowledged}
                        tone={counts.unacknowledged > 0 ? "amber" : "slate"}
                    />
                    <Stat
                        label={t("statUrgent")}
                        value={counts.urgentUnacknowledged}
                        tone={counts.urgentUnacknowledged > 0 ? "rose" : "slate"}
                    />
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-400">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t("loading")}
                </div>
            ) : items.length === 0 ? (
                <div className="rounded-3xl border border-gray-100 bg-white p-10 text-center">
                    <CircleCheck className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
                    <p className="font-bold text-gray-700">{t("empty")}</p>
                    <p className="mt-1 text-sm text-gray-400">{t("emptyHint")}</p>
                </div>
            ) : (
                <ul className="space-y-3">
                    {items.map((item) => {
                        const urgent = item.level === "urgent";
                        const acknowledged = Boolean(item.acknowledgedAt);
                        return (
                            <li
                                key={item.id}
                                className={`rounded-3xl border bg-white p-5 ${
                                    urgent && !acknowledged
                                        ? "border-rose-200 shadow-sm shadow-rose-100"
                                        : "border-gray-100"
                                }`}
                            >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span
                                                className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                                                    urgent
                                                        ? "bg-rose-100 text-rose-700"
                                                        : "bg-amber-100 text-amber-700"
                                                }`}
                                            >
                                                {urgent ? t("urgent") : t("elevated")}
                                            </span>
                                            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
                                                {SOURCE_LABEL[item.sourceType] ?? item.sourceType}
                                            </span>
                                            {acknowledged && (
                                                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-400">
                                                    <Clock className="h-3 w-3" />
                                                    {t("acknowledged")}
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-2 font-extrabold text-gray-900">
                                            {item.patient.name ?? t("unnamedPatient")}
                                        </p>
                                        <p className="mt-1 text-sm text-gray-600">{item.reason}</p>
                                    </div>
                                    <time className="shrink-0 text-xs text-gray-400">
                                        {new Date(item.createdAt).toLocaleString()}
                                    </time>
                                </div>

                                {item.patient.lastAssessment && (
                                    <p className="mt-3 text-xs text-gray-500">
                                        {t("latestScreening")}{" "}
                                        <strong>
                                            {item.patient.lastAssessment.type.toUpperCase()}{" "}
                                            {item.patient.lastAssessment.score}
                                        </strong>{" "}
                                        ({item.patient.lastAssessment.severity})
                                    </p>
                                )}

                                {item.resolutionNote && (
                                    <p className="mt-3 rounded-2xl bg-gray-50 p-3 text-xs text-gray-600">
                                        {t("noteLabel")} {item.resolutionNote}
                                    </p>
                                )}

                                <div className="mt-4 flex flex-wrap items-center gap-2">
                                    {!acknowledged && (
                                        <button
                                            type="button"
                                            disabled={acknowledge.isPending}
                                            onClick={async () => {
                                                try {
                                                    await acknowledge.mutateAsync(item.id);
                                                } catch {
                                                    toast(t("actionFailed"), "error");
                                                }
                                            }}
                                            className="inline-flex items-center gap-2 rounded-2xl bg-amber-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-amber-600 disabled:opacity-50"
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                            {t("acknowledge")}
                                        </button>
                                    )}

                                    {!item.resolvedAt && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setResolving(resolving === item.id ? null : item.id);
                                                setNote("");
                                            }}
                                            className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-700"
                                        >
                                            <CircleCheck className="h-3.5 w-3.5" />
                                            {t("resolve")}
                                        </button>
                                    )}

                                    {item.sourceType === "message" && item.sourceId && (
                                        <a
                                            href={`/messages/${item.patient.id}`}
                                            className="text-xs font-bold text-indigo-600 underline underline-offset-2"
                                        >
                                            {t("openConversation")}
                                        </a>
                                    )}
                                </div>

                                {resolving === item.id && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <input
                                            value={note}
                                            onChange={(e) => setNote(e.target.value)}
                                            placeholder={t("notePlaceholder")}
                                            maxLength={1000}
                                            className="min-w-0 flex-1 rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                                        />
                                        <button
                                            type="button"
                                            disabled={resolve.isPending}
                                            onClick={() => onResolve(item.id)}
                                            className="rounded-2xl bg-gray-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
                                        >
                                            {t("confirmResolve")}
                                        </button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {/* Spelled out, because the absence of a row is the one thing a
                clinician must be able to read correctly. */}
            <p className="mt-6 text-xs leading-relaxed text-gray-400">{t("footerNote")}</p>
        </DashboardLayout>
    );
}

function Stat({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone: "rose" | "amber" | "slate";
}) {
    const tones = {
        rose: "bg-rose-50 text-rose-700",
        amber: "bg-amber-50 text-amber-700",
        slate: "bg-gray-50 text-gray-600",
    } as const;
    return (
        <div className={`rounded-2xl p-4 ${tones[tone]}`}>
            <p className="text-2xl font-black">{value}</p>
            <p className="text-[11px] font-bold uppercase tracking-widest opacity-70">{label}</p>
        </div>
    );
}
