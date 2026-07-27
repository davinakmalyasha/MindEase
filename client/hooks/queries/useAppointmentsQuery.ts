"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export const appointmentKeys = {
    all: ["appointments"] as const,
    mine: ["appointments", "mine"] as const,
};

export const useMyAppointments = () =>
    useQuery({
        queryKey: appointmentKeys.mine,
        queryFn: async () => {
            const res = await api.get("/appointments/my");
            const data = res.data?.data;
            // Paginated shape: { rows, total, ... } — older shape: array
            return (Array.isArray(data) ? data : data?.rows) || [];
        },
    });

// Status changes with optimistic updates (instant UI, rollback on failure)
export const useUpdateAppointmentStatus = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ id, status }: { id: number; status: string }) => {
            const res = await api.put(`/appointments/${id}/status`, { status });
            return res.data?.data;
        },
        onMutate: async ({ id, status }) => {
            await queryClient.cancelQueries({ queryKey: appointmentKeys.mine });
            const previous = queryClient.getQueryData(appointmentKeys.mine);
            queryClient.setQueryData<any[]>(appointmentKeys.mine, (old) =>
                old ? old.map((a) => (a.id === id ? { ...a, status } : a)) : old
            );
            return { previous };
        },
        onError: (error, vars, context: any) => {
            if (context?.previous) queryClient.setQueryData(appointmentKeys.mine, context.previous);
            toast(getErrorMessage(error, "Status update failed"), "error");
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: appointmentKeys.mine });
        },
    });
};

export const useBookAppointment = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async (payload: any) => {
            const res = await api.post("/appointments/book", payload);
            return res.data?.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: appointmentKeys.mine });
            queryClient.invalidateQueries({ queryKey: ["doctors", "slots"] });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to book appointment"), "error");
        },
    });
};

export const useRescheduleAppointment = () => {
    const queryClient = useQueryClient();
    const { toast } = useToast();

    return useMutation({
        mutationFn: async ({ id, ...data }: { id: number; appointmentDate: string; startTime: string; endTime: string; slotId?: number }) => {
            const res = await api.put(`/appointments/${id}/reschedule`, data);
            return res.data?.data;
        },
        onSuccess: () => {
            toast("Appointment rescheduled — awaiting re-confirmation", "success");
            queryClient.invalidateQueries({ queryKey: appointmentKeys.mine });
        },
        onError: (error: any) => {
            toast(getErrorMessage(error, "Failed to reschedule"), "error");
        },
    });
};
