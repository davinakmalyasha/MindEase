"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { LifeBuoy, Loader2, Save, EyeOff, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";

/**
 * The patient's own safety plan.
 *
 * Patient-owned and never generated. There is no "generate this for me" and
 * there never will be: a support bot offering to write someone's safety plan
 * has misunderstood what the document is for. It is something a person may
 * have to read alone, at the worst possible moment, and it has to be in their
 * own words and about their own life.
 *
 * `warningSigns` is a free-text box on purpose. A checklist of symptoms is
 * useless to the person reading it, because they do not experience themselves
 * as a list of symptoms.
 *
 * Nothing here is hidden by default but nothing is announced either: the page
 * makes no claim that it is more secure than the rest of the platform, because
 * it is not. Anyone with access to the account can read it.
 */

export interface SafetyPlan {
    id: number;
    warningSigns: string | null;
    copingStrategies: string | null;
    reasonsToLive: string | null;
    contacts: string | null;
    professionalContact: string | null;
    locationToBeSafe: string | null;
    lastReviewedAt: string | null;
}

type Draft = {
    warningSigns: string;
    copingStrategies: string;
    reasonsToLive: string;
    contacts: string;
    professionalContact: string;
    locationToBeSafe: string;
};

const EMPTY: Draft = {
    warningSigns: "",
    copingStrategies: "",
    reasonsToLive: "",
    contacts: "",
    professionalContact: "",
    locationToBeSafe: "",
};

const toDraft = (p: SafetyPlan | null | undefined): Draft =>
    p
        ? {
              warningSigns: p.warningSigns ?? "",
              copingStrategies: p.copingStrategies ?? "",
              reasonsToLive: p.reasonsToLive ?? "",
              contacts: p.contacts ?? "",
              professionalContact: p.professionalContact ?? "",
              locationToBeSafe: p.locationToBeSafe ?? "",
          }
        : EMPTY;

export const safetyPlanKeys = { mine: ["safety-plan"] as const };

export default function SafetyPlanPage() {
    const t = useTranslations("features.safetyPlan");
    const { toast } = useToast();
    const qc = useQueryClient();
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const [preview, setPreview] = useState(false);

    // Which server payload the draft was seeded from.
    //
    // Keyed on the plan's *id*, not on the object reference. React Query returns
    // a new object on every successful refetch, so a reference comparison is true
    // every time - and `refetchOnWindowFocus` is on by default. A patient typing
    // into "reasons to live", alt-tabbing to check a message, and coming back
    // had their entire draft replaced by the last saved version. On a safety plan
    // that is not a lost form, it is lost crisis content.
    //
    // Seeding happens during render rather than in an effect: this is React's
    // documented "adjust state when a prop changes" pattern, and it avoids the
    // cascading render that `setState` inside `useEffect` causes - the form
    // would render once empty, then again populated, on every first load.
    //
    // An id comparison is false for every refetch of the same plan and true only
    // when a different plan arrives, which is the only case where re-seeding is
    // correct. `undefined` means "not seeded yet"; `null` means "seeded from the
    // server having no plan", which is a real state distinct from unseeded.
    const [seededId, setSeededId] = useState<number | null | undefined>(undefined);

    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: safetyPlanKeys.mine,
        queryFn: async () => {
            const res = await api.get("/safety-plan");
            // The API returns null rather than an empty object when nothing has
            // been written, so "not written yet" is distinguishable from
            // "written and deliberately left blank".
            return (res.data?.data ?? null) as SafetyPlan | null;
        },
    });

    const serverId = data?.id ?? null;
    if (data !== undefined && seededId === undefined) {
        setSeededId(serverId);
        setDraft(toDraft(data));
    }

    const save = useMutation({
        mutationFn: async (d: Draft) => {
            const res = await api.put("/safety-plan", d);
            return res.data?.data;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: safetyPlanKeys.mine });
            toast(t("saved"), "success");
        },
        onError: (error: unknown) => toast(getErrorMessage(error, t("saveFailed")), "error"),
    });

    const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
        setDraft((prev) => ({ ...prev, [key]: e.target.value }));

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

    // A failed load must not render an editable form.
    //
    // `isError` was never destructured, so a 500 left `data` undefined, `draft`
    // at EMPTY, and the page rendered a plausible blank safety plan. One click on
    // Save then sent `""` for all six fields - and the service treats an empty
    // string as *clear*, not as "unchanged". A transient network blip could
    // therefore erase a patient's reasons to live.
    //
    // There is no draft to save at this point, so there is nothing to offer but a
    // retry.
    if (isError) {
        return (
            <DashboardLayout>
                <div className="mb-6">
                    <h1 className="flex items-center gap-2 text-2xl font-extrabold text-gray-900">
                        <LifeBuoy className="h-6 w-6 text-rose-500" aria-hidden="true" />
                        {t("title")}
                    </h1>
                </div>
                <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
                    <h2 className="text-sm font-black text-rose-900">{t("loadFailedTitle")}</h2>
                    <p className="mt-2 text-sm text-rose-800">{t("loadFailedBody")}</p>
                    <button
                        onClick={() => refetch()}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700"
                    >
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        {t("retry")}
                    </button>
                </div>
            </DashboardLayout>
        );
    }

    const exists = Boolean(data?.id);

    return (
        <DashboardLayout>
            <div className="mb-6">
                <h1 className="flex items-center gap-2 text-2xl font-extrabold text-gray-900">
                    <LifeBuoy className="h-6 w-6 text-rose-500" />
                    {t("title")}
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-gray-500">{t("intro")}</p>
            </div>

            {!exists && (
                <div className="mb-6 rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
                    {t("emptyHint")}
                </div>
            )}

            {data?.lastReviewedAt && (
                <p className="mb-6 text-xs text-gray-400">
                    {t("lastReviewed")}{" "}
                    {new Date(data.lastReviewedAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                    })}
                </p>
            )}

            <div className="space-y-5">
                <Field
                    title={t("warningSignsTitle")}
                    hint={t("warningSignsHint")}
                    value={draft.warningSigns}
                    onChange={set("warningSigns")}
                    rows={4}
                />
                <Field
                    title={t("copingTitle")}
                    hint={t("copingHint")}
                    value={draft.copingStrategies}
                    onChange={set("copingStrategies")}
                    rows={4}
                />
                <Field
                    title={t("reasonsTitle")}
                    hint={t("reasonsHint")}
                    value={draft.reasonsToLive}
                    onChange={set("reasonsToLive")}
                    rows={3}
                />
                <Field
                    title={t("contactsTitle")}
                    hint={t("contactsHint")}
                    value={draft.contacts}
                    onChange={set("contacts")}
                    rows={4}
                />
                <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                        <label className="mb-1.5 block text-sm font-extrabold text-gray-900">
                            {t("professionalTitle")}
                        </label>
                        <input
                            value={draft.professionalContact}
                            onChange={set("professionalContact")}
                            maxLength={255}
                            className="w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-extrabold text-gray-900">
                            {t("locationTitle")}
                        </label>
                        <input
                            value={draft.locationToBeSafe}
                            onChange={set("locationToBeSafe")}
                            maxLength={255}
                            className="w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm"
                        />
                    </div>
                </div>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    disabled={save.isPending}
                    onClick={() => save.mutate(draft)}
                    className="inline-flex items-center gap-2 rounded-2xl bg-gray-900 px-5 py-3 text-sm font-bold text-white transition hover:bg-gray-700 disabled:opacity-50"
                >
                    <Save className="h-4 w-4" />
                    {t("save")}
                </button>
                <button
                    type="button"
                    onClick={() => setPreview((p) => !p)}
                    className={cn(
                        "inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold transition",
                        preview ? "bg-rose-50 text-rose-700" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    )}
                >
                    <EyeOff className="h-4 w-4" />
                    {preview ? t("hidePreview") : t("showPreview")}
                </button>
            </div>

            {preview && (
                <div className="mt-6 rounded-3xl border-2 border-rose-200 bg-white p-6">
                    <p className="mb-4 text-xs font-bold uppercase tracking-widest text-rose-500">
                        {t("previewLabel")}
                    </p>
                    <Preview label={t("warningSignsTitle")} value={draft.warningSigns} empty={t("notWritten")} />
                    <Preview label={t("copingTitle")} value={draft.copingStrategies} empty={t("notWritten")} />
                    <Preview label={t("reasonsTitle")} value={draft.reasonsToLive} empty={t("notWritten")} />
                    <Preview label={t("contactsTitle")} value={draft.contacts} empty={t("notWritten")} />
                    <Preview
                        label={t("professionalTitle")}
                        value={draft.professionalContact}
                        empty={t("notWritten")}
                    />
                    <Preview label={t("locationTitle")} value={draft.locationToBeSafe} empty={t("notWritten")} />
                </div>
            )}

            <p className="mt-6 text-xs leading-relaxed text-gray-400">{t("footerNote")}</p>
        </DashboardLayout>
    );
}

function Field({
    title,
    hint,
    value,
    onChange,
    rows,
}: {
    title: string;
    hint: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    rows: number;
}) {
    return (
        <div>
            <label className="mb-1 block text-sm font-extrabold text-gray-900">{title}</label>
            <p className="mb-2 text-xs text-gray-400">{hint}</p>
            <textarea
                value={value}
                onChange={onChange}
                rows={rows}
                maxLength={4000}
                className="w-full rounded-2xl border border-gray-200 px-3 py-2 text-sm leading-relaxed"
            />
        </div>
    );
}

function Preview({ label, value, empty }: { label: string; value: string; empty: string }) {
    return (
        <div className="mb-4 border-b border-gray-100 pb-3 last:border-0">
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400">{label}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{value.trim() || empty}</p>
        </div>
    );
}
