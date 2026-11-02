"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { formatDate } from "@/lib/format";
import { Target, Plus, Loader2, Check, X } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { ErrorState } from "@/components/ui/DataState";
import { cn } from "@/lib/utils";

/**
 * The patient's care plan.
 *
 * Patient-owned. The plan belongs to the patient rather than to the clinician
 * because clinicians leave and a plan has to survive that; a clinician can add
 * a goal here, but cannot rewrite the document, and the patient can complete or
 * drop anything on it.
 *
 * A goal can be *dropped* as well as achieved. That is the reason the status
 * selector offers both: a goal abandoned because it was wrong has to stay
 * distinguishable from one that was met, or the plan quietly overstates how
 * well it is going - to the person reading it, who is the patient.
 */

interface CareStep {
    id: string;
    title: string;
    done: boolean;
    order: number;
    dueDate: string | null;
}

interface CareGoal {
    id: string;
    title: string;
    detail: string | null;
    status: string;
    targetDate: string | null;
    barrier: string | null;
    order: number;
    steps: CareStep[];
}

interface CarePlan {
    id: string;
    title: string;
    status: string;
    summary: string | null;
    reviewAt: string | null;
    relapseSummary: string | null;
    earlyWarnings: string | null;
    supportContacts: string | null;
    version: number;
    goals: CareGoal[];
}

export const carePlanKeys = { mine: ["care-plan"] as const };

const STATUSES = ["open", "in_progress", "achieved", "dropped"] as const;

export default function CarePlanPage() {
    const t = useTranslations("features.carePlan");
    const locale = useLocale();
    const { toast } = useToast();
    const qc = useQueryClient();
    const [newGoal, setNewGoal] = useState("");
    const [newStepFor, setNewStepFor] = useState<string | null>(null);
    const [newStep, setNewStep] = useState("");
    const [newStepDue, setNewStepDue] = useState("");
    const [barrierFor, setBarrierFor] = useState<string | null>(null);
    const [barrierText, setBarrierText] = useState("");

    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: carePlanKeys.mine,
        queryFn: async () => {
            const res = await api.get("/care-plan");
            return res.data?.data as CarePlan;
        },
    });

    const invalidate = () => qc.invalidateQueries({ queryKey: carePlanKeys.mine });

    const addGoal = useMutation({
        mutationFn: async () => {
            // `data` is undefined when the plan failed to load. The old
            // `data!.id` threw a TypeError inside the mutation, which the
            // `onError` toast reported as a failure — after crashing first.
            if (!data) throw new Error("care plan not loaded");
            await api.post(`/care-plan/${data.id}/goals`, { title: newGoal.trim() });
        },
        onSuccess: () => {
            setNewGoal("");
            invalidate();
        },
        onError: () => toast(t("actionFailed"), "error"),
    });

    const setStatus = useMutation({
        mutationFn: async ({ id, status }: { id: string; status: string }) => {
            await api.put(`/care-plan/goals/${id}`, { status });
        },
        onSuccess: invalidate,
        onError: () => toast(t("actionFailed"), "error"),
    });

    const addStep = useMutation({
        mutationFn: async (goalId: string) => {
            await api.post(`/care-plan/goals/${goalId}/steps`, {
                title: newStep.trim(),
                dueDate: newStepDue || undefined,
            });
        },
        onSuccess: (_d, goalId) => {
            setNewStep("");
            setNewStepDue("");
            setNewStepFor(null);
            invalidate();
        },
        onError: () => toast(t("actionFailed"), "error"),
    });

    const saveBarrier = useMutation({
        mutationFn: async ({ id, barrier }: { id: string; barrier: string }) => {
            await api.put(`/care-plan/goals/${id}`, { barrier: barrier.trim() || null });
        },
        onSuccess: () => {
            setBarrierFor(null);
            setBarrierText("");
            invalidate();
        },
        onError: () => toast(t("actionFailed"), "error"),
    });

    const toggleStep = useMutation({
        mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
            await api.patch(`/care-plan/steps/${id}`, { done });
        },
        onSuccess: invalidate,
    });

    if (isLoading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-500">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t("loading")}
                </div>
            </DashboardLayout>
        );
    }

    // The plan failed to load, so there is nothing to add a goal to. The
    // shared error state (as on the dashboard) rather than an empty plan,
    // because an empty plan would claim the patient has no goals.
    if (isError || !data) {
        return (
            <DashboardLayout>
                <div className="mb-6">
                    <h1 className="flex items-center gap-2 text-2xl font-extrabold text-gray-900">
                        <Target className="h-6 w-6 text-indigo-500" />
                        {t("title")}
                    </h1>
                    <p className="mt-1 max-w-2xl text-sm text-gray-500">{t("intro")}</p>
                </div>
                <ErrorState detail={t("actionFailed")} onRetry={() => refetch()} />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout>
            <div className="mb-6">
                <h1 className="flex items-center gap-2 text-2xl font-extrabold text-gray-900">
                    <Target className="h-6 w-6 text-indigo-500" />
                    {t("title")}
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-gray-500">{t("intro")}</p>
            </div>

            {data?.reviewAt && (
                <p className="mb-6 rounded-2xl bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-900">
                    {t("reviewDue")}{" "}
                    {new Date(data.reviewAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                    })}
                </p>
            )}

            {data?.summary && (
                <p className="mb-6 whitespace-pre-wrap rounded-2xl border border-gray-100 bg-white p-4 text-sm leading-relaxed text-gray-700">
                    {data.summary}
                </p>
            )}

            {(data?.relapseSummary || data?.earlyWarnings || data?.supportContacts) && (
                <div className="mb-6 rounded-3xl border border-emerald-100 bg-emerald-50/60 p-5">
                    <h2 className="font-extrabold text-gray-900">{t("relapseTitle")}</h2>
                    <p className="mt-1 text-xs text-gray-500">{t("relapseHint")}</p>
                    {data?.relapseSummary && (
                        <p className="mt-3 text-sm text-gray-700"><strong>{t("relapseSummaryLabel")}: </strong>{data.relapseSummary}</p>
                    )}
                    {data?.earlyWarnings && (
                        <p className="mt-1 text-sm text-gray-700"><strong>{t("earlyWarningsLabel")}: </strong>{data.earlyWarnings}</p>
                    )}
                    {data?.supportContacts && (
                        <p className="mt-1 text-sm text-gray-700"><strong>{t("supportContactsLabel")}: </strong>{data.supportContacts}</p>
                    )}
                </div>
            )}

            <div className="mb-4 flex flex-wrap gap-2">
                <input
                    value={newGoal}
                    onChange={(e) => setNewGoal(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && newGoal.trim()) addGoal.mutate();
                    }}
                    placeholder={t("newGoalPlaceholder")}
                    maxLength={200}
                    className="min-w-0 flex-1 rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                />
                <button
                    type="button"
                    disabled={!newGoal.trim() || addGoal.isPending}
                    onClick={() => addGoal.mutate()}
                    className="inline-flex items-center gap-2 rounded-2xl bg-gray-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                    <Plus className="h-3.5 w-3.5" />
                    {t("addGoal")}
                </button>
            </div>

            {(data?.goals.length ?? 0) === 0 ? (
                <div className="rounded-3xl border border-gray-100 bg-white p-10 text-center">
                    <p className="font-bold text-gray-700">{t("empty")}</p>
                    <p className="mt-1 text-sm text-gray-500">{t("emptyHint")}</p>
                </div>
            ) : (
                <ul className="space-y-4">
                    {data.goals.map((goal) => (
                        <li key={goal.id} className="rounded-3xl border border-gray-100 bg-white p-5">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p
                                        className={cn(
                                            "font-extrabold text-gray-900",
                                            goal.status === "achieved" && "line-through opacity-60",
                                            goal.status === "dropped" && "italic opacity-50"
                                        )}
                                    >
                                        {goal.title}
                                    </p>
                                    {goal.detail && (
                                        <p className="mt-1 text-sm text-gray-500">{goal.detail}</p>
                                    )}
                                    {goal.targetDate && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            {t("target")}{" "}
                                            {formatDate(goal.targetDate, locale)}
                                        </p>
                                    )}
                                    {goal.barrier && (
                                        <p className="mt-1 text-xs text-amber-700">
                                            {t("barrierLabel")} {goal.barrier}
                                        </p>
                                    )}
                                    {barrierFor === goal.id ? (
                                        <div className="mt-2 flex gap-2">
                                            <input
                                                autoFocus
                                                value={barrierText}
                                                onChange={(e) => setBarrierText(e.target.value)}
                                                placeholder={t("barrierPlaceholder")}
                                                maxLength={2000}
                                                aria-label={t("barrierLabel")}
                                                className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => saveBarrier.mutate({ id: goal.id, barrier: barrierText })}
                                                className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-bold text-white"
                                            >
                                                <Check className="h-3.5 w-3.5" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setBarrierFor(null);
                                                    setBarrierText("");
                                                }}
                                                className="rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-bold text-gray-600"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setBarrierFor(goal.id);
                                                setBarrierText(goal.barrier ?? "");
                                            }}
                                            className="mt-1 text-xs font-bold text-amber-700 underline underline-offset-2"
                                        >
                                            {t("barrierLabel")}
                                        </button>
                                    )}
                                </div>
                                <select
                                    value={goal.status}
                                    onChange={(e) =>
                                        setStatus.mutate({ id: goal.id, status: e.target.value })
                                    }
                                    aria-label={t("statusLabel")}
                                    className="rounded-xl border border-gray-200 px-2 py-1 text-xs font-bold"
                                >
                                    {STATUSES.map((s) => (
                                        <option key={s} value={s}>
                                            {t(`status_${s}`)}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {goal.steps.length > 0 && (
                                <ul className="mt-4 space-y-2">
                                    {goal.steps.map((step) => {
                                        const overdue = step.dueDate && !step.done && new Date(step.dueDate) < new Date();
                                        return (
                                        <li key={step.id}>
                                            <label className="flex items-center gap-2.5 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={step.done}
                                                    onChange={(e) =>
                                                        toggleStep.mutate({
                                                            id: step.id,
                                                            done: e.target.checked,
                                                        })
                                                    }
                                                    className="h-4 w-4"
                                                />
                                                <span
                                                    className={cn(
                                                        step.done && "line-through opacity-50"
                                                    )}
                                                >
                                                    {step.title}
                                                </span>
                                                {step.dueDate && (
                                                    <span className={cn("text-[11px] font-bold", overdue ? "text-rose-600" : "text-gray-500")}>
                                                        {t("dueDateLabel")}: {formatDate(step.dueDate, locale)}
                                                        {overdue ? ` · ${t("overdueLabel")}` : ""}
                                                    </span>
                                                )}
                                            </label>
                                        </li>
                                        );
                                    })}
                                </ul>
                            )}

                            {newStepFor === goal.id ? (
                                <div className="mt-3 space-y-2">
                                    <div className="flex gap-2">
                                    <input
                                        autoFocus
                                        value={newStep}
                                        onChange={(e) => setNewStep(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && newStep.trim())
                                                addStep.mutate(goal.id);
                                        }}
                                        placeholder={t("newStepPlaceholder")}
                                        maxLength={200}
                                        aria-label={t("newStepPlaceholder")}
                                        className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => addStep.mutate(goal.id)}
                                        aria-label={t("addStep")}
                                        className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-bold text-white"
                                    >
                                        <Check className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setNewStepFor(null);
                                            setNewStep("");
                                            setNewStepDue("");
                                        }}
                                        aria-label={t("back")}
                                        className="rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-bold text-gray-600"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                    </div>
                                    <input
                                        type="date"
                                        value={newStepDue}
                                        onChange={(e) => setNewStepDue(e.target.value)}
                                        aria-label={t("dueDateLabel")}
                                        className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
                                    />
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setNewStepFor(goal.id)}
                                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    {t("addStep")}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <p className="mt-6 text-xs leading-relaxed text-gray-500">{t("footerNote")}</p>
        </DashboardLayout>
    );
}
