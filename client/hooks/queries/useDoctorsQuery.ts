"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

export const doctorKeys = {
    all: ["doctors"] as const,
    detail: (id: number | string) => ["doctors", "detail", String(id)] as const,
    slots: (id: number | string) => ["doctors", "slots", String(id)] as const,
    myPackages: ["doctors", "packages", "mine"] as const,
    packages: (id: number | string) => ["doctors", "packages", String(id)] as const,
};

export const useDoctorSlots = (id: number | string | null) =>
    useQuery({
        queryKey: doctorKeys.slots(id ?? "none"),
        queryFn: async () => {
            const res = await api.get(`/doctors/slots/${id}`);
            return (res.data?.data || []) as any[];
        },
        enabled: !!id,
    });

/**
 * The caller's own package entitlements.
 *
 * Note the path. BookingModal previously requested `GET /api/packages/my`, which
 * was never mounted, so every call 404'd and the rejection was swallowed by a
 * `catch` with a "best-effort" comment. Package-aware booking therefore never
 * ran, and because the whole feature is gated on the response, no user was ever
 * told it was broken.
 *
 * `/api/payments/purchases` is the canonical list: it excludes rows that never
 * settled, so an abandoned checkout is not presented as something the patient
 * owns.
 */
export const useMyPackages = (doctorId?: number | string | null) =>
    useQuery({
        queryKey: [...doctorKeys.myPackages, String(doctorId ?? "any")],
        queryFn: async () => {
            const res = await api.get("/payments/purchases");
            return (res.data?.data || []) as any[];
        },
        select: (purchases: any[]) =>
            doctorId == null
                ? purchases
                : purchases.filter(
                      (p) =>
                          p.status === "active" &&
                          p.sessionsLeft > 0 &&
                          p.package?.doctor?.id === doctorId
                  ),
    });

/**
 * A doctor's own practice analytics: bookings, revenue, cancellation rate,
 * monthly ratings, and an aggregate of their patients' logged moods.
 *
 * Doctor-only, so `enabled` follows the role. This page previously fetched with
 * a raw `api.get` in a `useEffect` and kept its own `isLoading` flag, which put
 * a permanent skeleton on screen whenever the request 403'd — a patient who
 * reached the URL saw a spinner forever instead of being told why.
 */
export const useDoctorAnalytics = (enabled: boolean) =>
    useQuery({
        queryKey: [...doctorKeys.all, "analytics"],
        queryFn: async () => {
            const res = await api.get("/doctors/analytics");
            return res.data?.data as any;
        },
        enabled,
        staleTime: 60_000,
    });
