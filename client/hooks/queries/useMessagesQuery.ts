"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export const messageKeys = {
    conversations: ["messages", "conversations"] as const,
    contacts: ["messages", "contacts"] as const,
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

/**
 * Users the caller may message but has no messages with yet.
 *
 * `useConversations` is message history, so without this the thread with a
 * clinician the user has a confirmed appointment with could not be opened at
 * all: the list was empty, and the appointments page's "Chat" button deep-links
 * into a thread that resolves against that same list. The gate for messaging is
 * the appointment; this is the appointment side of it.
 */
export const useChatContacts = () =>
    useQuery({
        queryKey: messageKeys.contacts,
        queryFn: async () => {
            const res = await api.get("/messages/contacts");
            return (res.data?.data || []) as {
                id: number;
                name: string;
                avatar: string | null;
                role: string;
            }[];
        },
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
        mutationFn: async ({
            receiverId,
            content,
            attachment,
        }: {
            receiverId: number;
            content: string;
            attachment?: { url: string; type: string };
        }) => {
            const res = await api.post(`/messages/${receiverId}`, { content, attachment });
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

export const useSendTyping = () =>
    useMutation({
        mutationFn: async ({ receiverId, isTyping }: { receiverId: number; isTyping: boolean }) => {
            await api.post(`/messages/${receiverId}/typing`, { isTyping });
        },
    });

export const useUploadAttachment = () => {
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ file, receiverId }: { file: File; receiverId: number }) => {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("receiverId", String(receiverId));
            const res = await api.post("/messages/upload", formData, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            return res.data?.data as { url: string; type: string };
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to upload attachment"), "error");
        },
    });
};

export const useDeleteMessage = (otherUserId: number) => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async (messageId: number) => {
            const res = await api.delete(`/messages/${messageId}`);
            return res.data?.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: messageKeys.thread(otherUserId) });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to delete message"), "error");
        },
    });
};

export const useSetReaction = (otherUserId: number) => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ messageId, reaction }: { messageId: number; reaction: string | null }) => {
            const res = await api.put(`/messages/${messageId}/reaction`, { reaction });
            return res.data?.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: messageKeys.thread(otherUserId) });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to update reaction"), "error");
        },
    });
};
