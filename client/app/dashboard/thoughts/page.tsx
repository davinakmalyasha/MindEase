"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Brain, Loader2, Trash2 } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useThoughtRecords, useCreateThought, useDeleteThought } from "@/hooks/queries/useThoughtsQuery";
import { ErrorState } from "@/components/ui/DataState";

export default function ThoughtsPage() {
    const t = useTranslations("features.thoughts");
    const { data: items = [], isLoading, isError, refetch } = useThoughtRecords();
    const create = useCreateThought();
    const remove = useDeleteThought();
    const [situation, setSituation] = useState("");
    const [thought, setThought] = useState("");
    const [balanced, setBalanced] = useState("");

    if (isLoading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-500" role="status" aria-live="polite">
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    {t("title")}
                </div>
            </DashboardLayout>
        );
    }

    if (isError) {
        return (
            <DashboardLayout>
                <ErrorState detail={t("title")} onRetry={() => refetch()} />
            </DashboardLayout>
        );
    }

    const save = () => {
        if (situation.trim().length < 3 || thought.trim().length < 3) return;
        create.mutate(
            { situation: situation.trim(), thought: thought.trim(), balanced: balanced.trim() || undefined },
            {
                onSuccess: () => {
                    setSituation("");
                    setThought("");
                    setBalanced("");
                },
            }
        );
    };

    return (
        <DashboardLayout>
            <div className="mb-6">
                <h1 className="flex items-center gap-2 text-2xl font-extrabold text-gray-900">
                    <Brain className="h-6 w-6 text-violet-500" aria-hidden="true" />
                    {t("title")}
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-gray-500">{t("subtitle")}</p>
            </div>

            <div className="mb-6 rounded-3xl border border-gray-100 bg-white p-5">
                <label className="mb-1 block text-sm font-extrabold text-gray-900" htmlFor="thought-situation">
                    {t("situationLabel")}
                </label>
                <textarea
                    id="thought-situation"
                    value={situation}
                    onChange={(e) => setSituation(e.target.value)}
                    placeholder={t("situationPlaceholder")}
                    rows={2}
                    maxLength={4000}
                    className="mb-3 w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                />
                <label className="mb-1 block text-sm font-extrabold text-gray-900" htmlFor="thought-auto">
                    {t("thoughtLabel")}
                </label>
                <textarea
                    id="thought-auto"
                    value={thought}
                    onChange={(e) => setThought(e.target.value)}
                    placeholder={t("thoughtPlaceholder")}
                    rows={2}
                    maxLength={4000}
                    className="mb-3 w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                />
                <label className="mb-1 block text-sm font-extrabold text-gray-900" htmlFor="thought-balanced">
                    {t("balancedLabel")}
                </label>
                <textarea
                    id="thought-balanced"
                    value={balanced}
                    onChange={(e) => setBalanced(e.target.value)}
                    rows={2}
                    maxLength={4000}
                    className="w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                />
                <button
                    type="button"
                    disabled={create.isPending || situation.trim().length < 3 || thought.trim().length < 3}
                    onClick={save}
                    className="mt-4 rounded-2xl bg-gray-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                >
                    {t("save")}
                </button>
            </div>

            {items.length === 0 ? (
                <p className="rounded-3xl border border-gray-100 bg-white p-10 text-center text-sm text-gray-500">{t("empty")}</p>
            ) : (
                <ul className="space-y-3">
                    {items.map((it: any) => (
                        <li key={it.id} className="rounded-3xl border border-gray-100 bg-white p-5">
                            <p className="text-sm font-extrabold text-gray-900">{it.situation}</p>
                            <p className="mt-1 text-sm text-gray-600">{it.thought}</p>
                            {it.balanced && <p className="mt-2 text-sm text-emerald-700">→ {it.balanced}</p>}
                            <button
                                type="button"
                                aria-label={t("deleteConfirm")}
                                onClick={() => remove.mutate(it.id)}
                                className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-gray-500 hover:text-rose-600"
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                {t("deleteConfirm")}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </DashboardLayout>
    );
}
