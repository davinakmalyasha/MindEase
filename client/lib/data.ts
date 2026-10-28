export interface Testimonial {
    id: number;
    quote: string;
    name: string;
    rating: number;
    role: string;
    avatarUrl: string;
}

import { Doctor, AppointmentWithDoctor } from "./types/doctor";
export type { Doctor, AppointmentWithDoctor };

/**
 * Removed: six hardcoded testimonials with invented names, roles, quotes and
 * star ratings (one praised "telepathy consultations"). Fabricated social
 * proof has no place on a mental-health platform; the home page section that
 * rendered these now describes the product instead.
 */


export const MOCK_MY_APPOINTMENTS: AppointmentWithDoctor[] = [
    {
        id: "1",
        appointmentDate: "2026-02-18T10:00:00Z",
        status: "confirmed",
        doctor: {
            id: "1",
            name: "Dr. Sarah Althea, M.Psi",
            specialty: "Psychology",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=SarahDr",
            rating: 4.9,
        },
    },
    {
        id: "2",
        appointmentDate: "2026-02-19T14:00:00Z",
        status: "pending",
        doctor: {
            id: "2",
            name: "Dr. Adrian Wijaya, Sp.KJ",
            specialty: "Psychiatry",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=AdrianDr",
            rating: 5.0,
        },
    },
    {
        id: "3",
        appointmentDate: "2026-02-15T09:00:00Z",
        status: "completed",
        doctor: {
            id: "3",
            name: "Maya Sari, M.Psi",
            specialty: "Counseling",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=MayaDr",
            rating: 4.8,
        },
    },
    {
        id: "4",
        appointmentDate: "2026-02-14T16:00:00Z",
        status: "cancelled",
        doctor: {
            id: "4",
            name: "Budi Santoso, S.Psi",
            specialty: "Clinical",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=BudiDr",
            rating: 4.7,
        },
    },
];
