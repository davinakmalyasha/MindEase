"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export const messageKeys = {
    conversations: ["messages", "conversations"] as const,
    thread: (userId: number) => ["messages", "thread", userId] as const,
};

export const useConversations = (refetchInterval = 30000) =>
    useQuery({
        queryKey: messageKeys.conversations,
        queryFn: async () => {
            const res = await api.get("/messages/conversations");
            return (res.data?.data || []) as any[];
        },
        refetchInterval,
    });

export const useMessageThread = (otherUserId: number | null, refetchInterval = 5000) =>
    useQuery({
        queryKey: messageKeys.thread(otherUserId ?? 0),
        queryFn: async () => {
            const res = await api.get(`/messages/${otherUserId}/messages`);
            return (res.data?.data || []) as any[];
        },
        enabled: !!otherUserId,
        refetchInterval: otherUserId ? refetchInterval : false,
    });

export const useSendMessage = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ receiverId, content }: { receiverId: number; content: string }) => {
            const res = await api.post(`/messages/${receiverId}`, { content });
            return res.data?.data;
        },
        onSuccess: (message, vars) => {
            queryClient.invalidateQueries({ queryKey: messageKeys.thread(vars.receiverId) });
            queryClient.invalidateQueries({ queryKey: messageKeys.conversations });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to send message"), "error");
        },
    });
};
