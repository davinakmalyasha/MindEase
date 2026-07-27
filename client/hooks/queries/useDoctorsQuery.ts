"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

export const doctorKeys = {
    all: ["doctors"] as const,
    detail: (id: number | string) => ["doctors", "detail", String(id)] as const,
    slots: (id: number | string) => ["doctors", "slots", String(id)] as const,
    stats: ["doctors", "stats"] as const,
};

export const useDoctors = () =>
    useQuery({
        queryKey: doctorKeys.all,
        queryFn: async () => {
            const res = await api.get("/doctors");
            return (res.data?.data || []) as any[];
        },
    });

export const useDoctorDetail = (id: number | string | null) =>
    useQuery({
        queryKey: doctorKeys.detail(id ?? "none"),
        queryFn: async () => {
            const res = await api.get(`/doctors/${id}`);
            return res.data?.data as any;
        },
        enabled: !!id,
    });

export const useDoctorSlots = (id: number | string | null) =>
    useQuery({
        queryKey: doctorKeys.slots(id ?? "none"),
        queryFn: async () => {
            const res = await api.get(`/doctors/slots/${id}`);
            return (res.data?.data || []) as any[];
        },
        enabled: !!id,
    });

export const useDoctorStats = (enabled = false) =>
    useQuery({
        queryKey: doctorKeys.stats,
        queryFn: async () => {
            const res = await api.get("/doctors/stats");
            return res.data?.data as any;
        },
        enabled,
    });
