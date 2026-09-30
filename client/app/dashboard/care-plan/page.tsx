"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Target, Plus, Loader2, Check, X } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
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
    id: number;
    title: string;
    done: boolean;
    order: number;
}

interface CareGoal {
    id: number;
    title: string;
    detail: string | null;
    status: string;
    targetDate: string | null;
    order: number;
    steps: CareStep[];
}

interface CarePlan {
    id: number;
    title: string;
    status: string;
    summary: string | null;
    reviewAt: string | null;
    goals: CareGoal[];
}

export const carePlanKeys = { mine: ["care-plan"] as const };

const STATUSES = ["open", "in_progress", "achieved", "dropped"] as const;

export default function CarePlanPage() {
    const t = useTranslations("features.carePlan");
    const { toast } = useToast();
    const qc = useQueryClient();
    const [newGoal, setNewGoal] = useState("");
    const [newStepFor, setNewStepFor] = useState<number | null>(null);
    const [newStep, setNewStep] = useState("");

    const { data, isLoading } = useQuery({
        queryKey: carePlanKeys.mine,
        queryFn: async () => {
            const res = await api.get("/care-plan");
            return res.data?.data as CarePlan;
        },
    });

    const invalidate = () => qc.invalidateQueries({ queryKey: carePlanKeys.mine });

    const addGoal = useMutation({
        mutationFn: async () => {
            await api.post(`/care-plan/${data!.id}/goals`, { title: newGoal.trim() });
        },
        onSuccess: () => {
            setNewGoal("");
            invalidate();
        },
        onError: () => toast(t("actionFailed"), "error"),
    });

    const setStatus = useMutation({
        mutationFn: async ({ id, status }: { id: number; status: string }) => {
            await api.put(`/care-plan/goals/${id}`, { status });
        },
        onSuccess: invalidate,
        onError: () => toast(t("actionFailed"), "error"),
    });

    const addStep = useMutation({
        mutationFn: async (goalId: number) => {
            await api.post(`/care-plan/goals/${goalId}/steps`, { title: newStep.trim() });
        },
        onSuccess: (_d, goalId) => {
            setNewStep("");
            setNewStepFor(null);
            invalidate();
        },
        onError: () => toast(t("actionFailed"), "error"),
    });

    const toggleStep = useMutation({
        mutationFn: async ({ id, done }: { id: number; done: boolean }) => {
            await api.patch(`/care-plan/steps/${id}`, { done });
        },
        onSuccess: invalidate,
    });

    if (isLoading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-400">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t("loading")}
                </div>
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
                    <p className="mt-1 text-sm text-gray-400">{t("emptyHint")}</p>
                </div>
            ) : (
                <ul className="space-y-4">
                    {data!.goals.map((goal) => (
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
                                        <p className="mt-1 text-xs text-gray-400">
                                            {t("target")}{" "}
                                            {new Date(goal.targetDate).toLocaleDateString()}
                                        </p>
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
                                    {goal.steps.map((step) => (
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
                                            </label>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {newStepFor === goal.id ? (
                                <div className="mt-3 flex gap-2">
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
                                        className="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => addStep.mutate(goal.id)}
                                        className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-bold text-white"
                                    >
                                        <Check className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setNewStepFor(null);
                                            setNewStep("");
                                        }}
                                        className="rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-bold text-gray-600"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
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

            <p className="mt-6 text-xs leading-relaxed text-gray-400">{t("footerNote")}</p>
        </DashboardLayout>
    );
}
