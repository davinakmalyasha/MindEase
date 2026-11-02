"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export function SessionFeedback({ appointmentId }: { appointmentId: string }) {
    const t = useTranslations("features.feedback");
    const qc = useQueryClient();
    const { toast } = useToast();
    const [scores, setScores] = useState({ listening: 8, goals: 8, approach: 8, overall: 8 });

    const { data, isLoading } = useQuery({
        queryKey: ["feedback", appointmentId],
        queryFn: async () => {
            const res = await api.get(`/appointments/${appointmentId}/feedback`);
            return res.data?.data as any;
        },
    });

    const save = useMutation({
        mutationFn: async () => {
            const res = await api.post(`/appointments/${appointmentId}/feedback`, scores);
            return res.data?.data;
        },
        onSuccess: () => {
            toast(t("saved"), "success");
            qc.invalidateQueries({ queryKey: ["feedback", appointmentId] });
        },
        onError: (e: unknown) => toast(getErrorMessage(e, t("title")), "error"),
    });

    if (isLoading) return null;
    if (data) {
        return (
            <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
                {t("saved")} ({data.overall}/10)
            </p>
        );
    }

    return (
        <div className="rounded-3xl border border-gray-100 bg-white p-5">
            <h3 className="font-extrabold text-gray-900">{t("title")}</h3>
            <p className="mt-1 text-xs text-gray-500">{t("subtitle")}</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
                {(["listening", "goals", "approach", "overall"] as const).map((k) => (
                    <label key={k} className="text-xs font-bold text-gray-600">
                        {t(k)}
                        <input
                            type="range"
                            min={0}
                            max={10}
                            value={scores[k]}
                            onChange={(e) => setScores((s) => ({ ...s, [k]: Number(e.target.value) }))}
                            aria-label={t(k)}
                            className="mt-1 w-full"
                        />
                        <span className="text-sm font-black text-gray-900">{scores[k]}</span>
                    </label>
                ))}
            </div>
            <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate()}
                className="mt-4 rounded-2xl bg-gray-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
            >
                {t("submit")}
            </button>
        </div>
    );
}
