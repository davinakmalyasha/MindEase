"use client";

import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export function ConsentToggles() {
    const t = useTranslations("features.consent");
    const qc = useQueryClient();
    const { toast } = useToast();
    const { data } = useQuery({
        queryKey: ["consents"],
        queryFn: async () => {
            const res = await api.get("/account/consents");
            return res.data?.data as Record<string, { granted: boolean }>;
        },
    });
    const save = useMutation({
        mutationFn: async ({ purpose, granted }: { purpose: string; granted: boolean }) => {
            const res = await api.put("/account/consents", { purpose, granted });
            return res.data?.data;
        },
        onSuccess: () => {
            toast(t("saved"), "success");
            qc.invalidateQueries({ queryKey: ["consents"] });
        },
        onError: (e: unknown) => toast(getErrorMessage(e, t("title")), "error"),
    });

    const aiRead = data?.["ai-read"]?.granted ?? false;
    const dataShare = data?.["data-share"]?.granted ?? false;

    return (
        <div className="rounded-3xl border border-gray-100 bg-white p-5">
            <h3 className="font-extrabold text-gray-900">{t("title")}</h3>
            <label className="mt-4 flex items-start gap-3 text-sm">
                <input
                    type="checkbox"
                    checked={aiRead}
                    onChange={(e) => save.mutate({ purpose: "ai-read", granted: e.target.checked })}
                    className="mt-1 h-4 w-4"
                />
                <span>
                    <span className="font-bold text-gray-900">{t("aiReadTitle")}</span>
                    <span className="block text-xs text-gray-500">{t("aiReadBody")}</span>
                </span>
            </label>
            <label className="mt-4 flex items-start gap-3 text-sm">
                <input
                    type="checkbox"
                    checked={dataShare}
                    onChange={(e) => save.mutate({ purpose: "data-share", granted: e.target.checked })}
                    className="mt-1 h-4 w-4"
                />
                <span>
                    <span className="font-bold text-gray-900">{t("dataShareTitle")}</span>
                    <span className="block text-xs text-gray-500">{t("dataShareBody")}</span>
                </span>
            </label>
        </div>
    );
}
