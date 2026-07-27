"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export const moodKeys = {
    history: ["mood", "history"] as const,
    stats: ["mood", "stats"] as const,
    suggestions: ["mood", "suggestions"] as const,
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
        mutationFn: async ({ mood, notes }: { mood: number; notes?: string }) => {
            const res = await api.post("/wellness/mood", { mood, notes });
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
