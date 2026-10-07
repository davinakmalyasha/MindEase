"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export const moodKeys = {
    history: ["mood", "history"] as const,
    stats: ["mood", "stats"] as const,
    suggestions: ["mood", "suggestions"] as const,
    journal: ["journal"] as const,
    assessments: ["assessments"] as const,
};

export const useMoodHistory = (days = 14) =>
    useQuery({
        queryKey: [...moodKeys.history, days],
        queryFn: async () => {
            const res = await api.get(`/wellness/mood?days=${days}`);
            return (res.data?.data || []) as any[];
        },
    });

export const useMoodStats = () =>
    useQuery({
        queryKey: moodKeys.stats,
        queryFn: async () => {
            const res = await api.get("/wellness/mood/stats");
            return res.data?.data as any;
        },
    });

export const useLogMood = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ mood, notes, factors }: { mood: number; notes?: string; factors?: string[] }) => {
            const res = await api.post("/wellness/mood", { mood, notes, factors });
            return res.data?.data as { replaced?: boolean } | undefined;
        },
        onSuccess: (data) => {
            // The server keeps one entry per calendar day, so a second log
            // replaces the first. Say so, rather than claiming a fresh log.
            toast(
                data?.replaced
                    ? "Today's entry was updated"
                    : "Mood logged. Take care of yourself! 💙",
                "success"
            );
            queryClient.invalidateQueries({ queryKey: moodKeys.history });
            queryClient.invalidateQueries({ queryKey: moodKeys.stats });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to log mood"), "error");
        },
    });
};

export const useWellnessSuggestions = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async () => {
            const res = await api.post("/ai/resources");
            return {
                suggestions: (res.data?.data || []) as any[],
                // Whether these were personalised or picked from the fixed list.
                source: res.data?.ai?.source as "model" | "fallback" | undefined,
            };
        },
        onSuccess: ({ suggestions, source }) => {
            queryClient.setQueryData(moodKeys.suggestions, { suggestions, source });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to load suggestions"), "error");
        },
    });
};

export const useJournalEntries = (limit = 20) =>
    useQuery({
        queryKey: [...moodKeys.journal, limit],
        queryFn: async () => {
            const res = await api.get(`/wellness/journal?limit=${limit}`);
            return (res.data?.data || []) as any[];
        },
    });

export const useCreateJournalEntry = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async (content: string) => {
            const res = await api.post("/wellness/journal", { content });
            return res.data?.data;
        },
        onSuccess: () => {
            toast("Journal entry saved", "success");
            queryClient.invalidateQueries({ queryKey: moodKeys.journal });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to save journal entry"), "error");
        },
    });
};

export const useUpdateJournalEntry = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ id, content }: { id: number; content: string }) => {
            const res = await api.put(`/wellness/journal/${id}`, { content });
            return res.data?.data;
        },
        onSuccess: () => {
            toast("Journal entry updated", "success");
            queryClient.invalidateQueries({ queryKey: moodKeys.journal });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to update journal entry"), "error");
        },
    });
};

export const useDeleteJournalEntry = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async (id: number) => {
            await api.delete(`/wellness/journal/${id}`);
        },
        onSuccess: () => {
            toast("Journal entry deleted", "success");
            queryClient.invalidateQueries({ queryKey: moodKeys.journal });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to delete journal entry"), "error");
        },
    });
};

export const useSummarizeJournal = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async () => {
            const res = await api.post("/wellness/journal/summarize");
            return {
                summary: (res.data?.data?.summary ?? null) as string | null,
                count: (res.data?.data?.count ?? 0) as number,
                source: res.data?.data?.ai?.source as "model" | "fallback" | undefined,
            };
        },
        onSuccess: ({ summary, source }) => {
            if (!summary) {
                toast("Write at least one entry first", "error");
            } else if (source === "fallback") {
                // The summary is a fixed encouragement paragraph, not a reading
                // of their entries — saying "here's your week" would misrepresent it.
                toast("Our AI reflection is unavailable, so this is a standard note.", "info");
            }
            queryClient.invalidateQueries({ queryKey: moodKeys.journal });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to summarize journal"), "error");
        },
    });
};

export const useAssessments = (type?: string, limit = 10) =>
    useQuery({
        queryKey: [...moodKeys.assessments, type ?? "all", limit],
        queryFn: async () => {
            const res = await api.get(`/wellness/assessments?${type ? `type=${type}&` : ""}limit=${limit}`);
            return (res.data?.data || []) as any[];
        },
    });

/**
 * Longitudinal screening trajectory.
 *
 * Separate from `useAssessments`, which returns the raw history newest-first.
 * The trajectory is oldest-first, scored against the instrument's own range,
 * and carries the severity bands and a direction the chart would otherwise
 * have to derive - and a chart that derives the bands itself is how the two
 * instruments end up plotted on one wrong axis.
 */
export interface TrajectoryResponse {
    type: string;
    instrument: { label: string; max: number; bands: { upTo: number; severity: string }[] };
    points: {
        id: number;
        score: number;
        severity: string;
        createdAt: string;
        changeFromPrevious: number | null;
    }[];
    summary: {
        sittings: number;
        first: number | null;
        latest: number | null;
        totalChange: number | null;
        direction: "improving" | "worsening" | "stable" | "insufficient-data";
    };
}

export const useAssessmentTrajectory = (type: "phq9" | "gad7") =>
    useQuery({
        queryKey: [...moodKeys.assessments, "trajectory", type],
        queryFn: async () => {
            const res = await api.get(`/wellness/assessments/trajectory?type=${type}`);
            return res.data?.data as TrajectoryResponse;
        },
    });

/** One crisis hotline as returned by the API. */
export interface CrisisHotline {
    name: string;
    dial: string;
    contact: string;
    whatsapp: boolean;
}

/**
 * The risk half of a screening submission.
 *
 * Modelled as a type rather than left as part of an untyped blob because it
 * carries the safety signal: a patient who answers PHQ-9 item 9 above "not at
 * all" has a clinician paged, and the response tells the client so. The result
 * screen used to spread this into `any` and render only the score, which meant a
 * disclosure produced a green tick and "your result has been saved".
 */
export interface AssessmentRiskSignal {
    riskFlag: boolean;
    level: "elevated" | "urgent" | null;
    reason: string | null;
    hotlines: CrisisHotline[];
    crisisPage: string;
    /** Whether a clinician could actually be reached. */
    clinicianNotified: boolean;
    /** Whether the RiskAlert row was written. False means no audit trail. */
    recorded: boolean;
    /** The queued item, so a clinician-facing view can link to it. */
    alertId: number | null;
}

/** What `POST /wellness/assessments` returns. */
export interface SubmittedAssessment {
    score: number;
    severity: string;
    risk: AssessmentRiskSignal;
}

export const useSubmitAssessment = () => {
    const queryClient = useQueryClient();    const { toast } = useToast();

    return useMutation<SubmittedAssessment, unknown, { type: string; answers: number[] }>({
        mutationFn: async ({ type, answers }: { type: string; answers: number[] }) => {
            const res = await api.post("/wellness/assessments", { type, answers });
            return res.data?.data as SubmittedAssessment;
        },
        onSuccess: () => {
            toast("Assessment submitted", "success");
            queryClient.invalidateQueries({ queryKey: moodKeys.assessments });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to submit assessment"), "error");
        },
    });
};
