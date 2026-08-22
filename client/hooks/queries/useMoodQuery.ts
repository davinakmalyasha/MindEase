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
            return res.data?.data;
        },
        onSuccess: () => {
            toast("Mood logged. Take care of yourself! 💙", "success");
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
            return (res.data?.data || []) as any[];
        },
        onSuccess: (suggestions) => {
            queryClient.setQueryData(moodKeys.suggestions, suggestions);
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
            return res.data?.data as { summary: string | null; count: number };
        },
        onSuccess: (data) => {
            if (!data.summary) {
                toast("Write at least one entry first", "error");
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

export const useSubmitAssessment = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ type, answers }: { type: string; answers: number[] }) => {
            const res = await api.post("/wellness/assessments", { type, answers });
            return res.data?.data;
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
