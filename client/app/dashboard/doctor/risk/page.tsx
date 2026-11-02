"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { ShieldAlert, Loader2, Check, CircleCheck, Clock, AlertTriangle, RotateCcw } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import {
    useRiskQueue,
    useAcknowledgeRisk,
    useResolveRisk,
    useRiskAlertListener,
    riskErrorMessage,
    SOURCE_KEY,
    SEVERITY_KEY,
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
    const format = useFormatter();
    const { toast } = useToast();
    const [includeResolved, setIncludeResolved] = useState(false);
    const [resolving, setResolving] = useState<string | null>(null);
    const [note, setNote] = useState("");
    const [outcome, setOutcome] = useState("");
    const [followUp, setFollowUp] = useState("");

    const { data, isLoading, isError, error, refetch } = useRiskQueue(includeResolved);
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

    const onResolve = async (id: string) => {
        try {
            await resolve.mutateAsync({
                id,
                note: note.trim() || undefined,
                outcome: outcome || undefined,
                followUpDueAt: followUp || undefined,
            });
            setNote("");
            setOutcome("");
            setFollowUp("");
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
            {counts && ((counts as any).overdue > 0 || (counts as any).followUpDue > 0) && (
                <p role="status" className="mb-4 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-2 text-xs font-bold text-amber-800">
                    {t("statOverdue")}: {(counts as any).overdue} · {t("statFollowUpDue")}: {(counts as any).followUpDue} · {t("slaHint")}
                </p>
            )}

            {isLoading ? (
                <div
                    className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-500"
                    role="status"
                    aria-live="polite"
                >
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    {t("loading")}
                </div>
            ) : isError ? (
                // A clinician who cannot load the queue must never be told it is
                // empty. `items` is `data?.items ?? []`, so before this branch
                // existed a 403, a 500 and a dropped connection all rendered the
                // green "nothing outstanding" state below - the one screen in the
                // product where a false negative can hide an open disclosure of
                // thoughts of self-harm. Reachable by a patient who typed the
                // URL, and by any clinician whose session expired.
                <div
                    className="rounded-3xl border border-amber-200 bg-amber-50 p-10 text-center"
                    role="alert"
                >
                    <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-amber-600" aria-hidden="true" />
                    <p className="font-bold text-amber-900">{t("loadFailed")}</p>
                    <p className="mt-1 text-sm text-amber-800">{riskErrorMessage(error, t("loadFailed"))}</p>
                    <button
                        type="button"
                        onClick={() => refetch()}
                        className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-amber-900 px-5 py-3 text-sm font-bold text-white"
                    >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        {t("retry")}
                    </button>
                </div>
            ) : items.length === 0 ? (
                <div className="rounded-3xl border border-gray-100 bg-white p-10 text-center">
                    <CircleCheck className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
                    <p className="font-bold text-gray-700">{t("empty")}</p>
                    <p className="mt-1 text-sm text-gray-500">{t("emptyHint")}</p>
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
                                            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
                                                {(() => {
                                                    const key = SOURCE_KEY[item.sourceType];
                                                    return key ? t(key) : item.sourceType;
                                                })()}
                                            </span>
                                            {acknowledged && (
                                                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-500">
                                                    <Clock className="h-3 w-3" />
                                                    {t("acknowledged")}
                                                </span>
                                            )}
                                            {item.isOverdue && !item.resolvedAt && (
                                                <span className="rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white">
                                                    {t("overdueBadge", { hours: Math.round(item.hoursOpen) })}
                                                </span>
                                            )}
                                            {item.followUpOverdue && (
                                                <span className="rounded-full bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white">
                                                    {t("followUpBadge")}
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-2 font-extrabold text-gray-900">
                                            {item.patient.name ?? t("unnamedPatient")}
                                        </p>
                                        <p className="mt-1 text-sm text-gray-600">{item.reason}</p>
                                    </div>
                                    <time className="shrink-0 text-xs text-gray-500">
                                        {/* `useFormatter` rather than a bare
                                            `toLocaleString()`, which silently used
                                            the browser's locale - so someone who
                                            chose Indonesian still got their OS
                                            default on the triage screen. */}
                                        {format.dateTime(new Date(item.createdAt), {
                                            dateStyle: "medium",
                                            timeStyle: "short",
                                        })}
                                    </time>
                                </div>

                                {item.patient.lastAssessment && (
                                    <p className="mt-3 text-xs text-gray-500">
                                        {t("latestScreening")}{" "}
                                        <strong>
                                            {item.patient.lastAssessment.type.toUpperCase()}{" "}
                                            {item.patient.lastAssessment.score}
                                        </strong>{" "}
                                        {/* The raw slug - "moderately-severe" - used
                                            to be rendered here. */}
                                        {(() => {
                                            const key =
                                                SEVERITY_KEY[item.patient.lastAssessment.severity];
                                            return key
                                                ? t(key)
                                                : item.patient.lastAssessment.severity;
                                        })()}
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
                                                setOutcome("");
                                                setFollowUp("");
                                            }}
                                            className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-700"
                                        >
                                            <CircleCheck className="h-3.5 w-3.5" />
                                            {t("resolve")}
                                        </button>
                                    )}

                                    {item.sourceType === "message" && item.sourceId && (
                                        /* `?with=`, not a path segment. There is no
                                           `app/messages/[id]` route, so
                                           `/messages/12` was a 404 - on the
                                           highest-stakes link in the product, the
                                           one a clinician clicks when a crisis
                                           phrase has just come in. The messages
                                           page already reads `with` and
                                           preselects the thread, which is exactly
                                           what the appointments page does. */
                                        <Link
                                            href={`/messages?with=${item.patient.id}`}
                                            className="text-xs font-bold text-indigo-600 underline underline-offset-2"
                                        >
                                            {t("openConversation")}
                                        </Link>
                                    )}
                                </div>

                                {resolving === item.id && (
                                    <div className="mt-3 space-y-2">
                                        <div className="flex flex-wrap gap-2">
                                            <input
                                                value={note}
                                                onChange={(e) => setNote(e.target.value)}
                                                placeholder={t("notePlaceholder")}
                                                maxLength={1000}
                                                aria-label={t("notePlaceholder")}
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
                                        <div className="flex flex-wrap gap-2">
                                            <label className="text-xs font-bold text-gray-500">
                                                {t("outcomeLabel")}
                                                <select
                                                    value={outcome}
                                                    onChange={(e) => setOutcome(e.target.value)}
                                                    aria-label={t("outcomeLabel")}
                                                    className="ml-2 rounded-xl border border-gray-200 px-2 py-1.5 text-xs"
                                                >
                                                    <option value="">{t("outcomePlaceholder")}</option>
                                                    <option value="contacted">{t("outcome_contacted")}</option>
                                                    <option value="scheduled">{t("outcome_scheduled")}</option>
                                                    <option value="referred">{t("outcome_referred")}</option>
                                                    <option value="hotline-given">{t("outcome_hotline-given")}</option>
                                                    <option value="no-answer">{t("outcome_no-answer")}</option>
                                                    <option value="other">{t("outcome_other")}</option>
                                                </select>
                                            </label>
                                            <label className="text-xs font-bold text-gray-500">
                                                {t("followUpLabel")}
                                                <input
                                                    type="date"
                                                    value={followUp}
                                                    onChange={(e) => setFollowUp(e.target.value)}
                                                    aria-label={t("followUpLabel")}
                                                    className="ml-2 rounded-xl border border-gray-200 px-2 py-1.5 text-xs"
                                                />
                                            </label>
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {/* Spelled out, because the absence of a row is the one thing a
                clinician must be able to read correctly. */}
            <p className="mt-6 text-xs leading-relaxed text-gray-500">{t("footerNote")}</p>
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
