"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export const thoughtKeys = { all: ["thought-records"] as const };

export const useThoughtRecords = (limit = 20) =>
    useQuery({
        queryKey: [...thoughtKeys.all, limit],
        queryFn: async () => {
            const res = await api.get(`/wellness/thought-records?limit=${limit}`);
            return (res.data?.data || []) as any[];
        },
    });

export const useCreateThought = () => {
    const qc = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: async (input: Record<string, unknown>) => {
            const res = await api.post("/wellness/thought-records", input);
            return res.data?.data;
        },
        onSuccess: () => {
            toast("Saved", "success");
            qc.invalidateQueries({ queryKey: thoughtKeys.all });
        },
        onError: (e: unknown) => toast(getErrorMessage(e, "Could not save"), "error"),
    });
};

export const useDeleteThought = () => {
    const qc = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: async (id: string) => {
            await api.delete(`/wellness/thought-records/${id}`);
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: thoughtKeys.all }),
        onError: (e: unknown) => toast(getErrorMessage(e, "Could not delete"), "error"),
    });
};
