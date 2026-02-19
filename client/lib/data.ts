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

export const TESTIMONIALS: Testimonial[] = [
    {
        id: 1,
        quote: "This app is a lifesaver! Mindease has completely transformed how I deal with stress and anxiety.",
        name: "Sarah Johnson",
        rating: 5,
        role: "Graphic Designer",
        avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah",
    },
    {
        id: 2,
        quote: "The telepathy consultations are truly professional. I feel much lighter after every session.",
        name: "Michael Chen",
        rating: 5,
        role: "Software Engineer",
        avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Michael",
    },
    {
        id: 3,
        quote: "Finally a platform that understands mental health as a priority. Highly recommended!",
        name: "Emily Davis",
        rating: 4,
        role: "Teacher",
        avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Emily",
    },
    {
        id: 4,
        quote: "Finding a therapist has never been this easy. The interface is so soothing.",
        name: "James Wilson",
        rating: 5,
        role: "Student",
        avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=James",
    },
    {
        id: 5,
        quote: "MindEase helped me discover the power of meditation in my recovery journey.",
        name: "Lisa Anderson",
        rating: 4,
        role: "Blogger",
        avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Lisa",
    },
    {
        id: 6,
        quote: "Top-notch psychologists and mental health experts. Best investment for myself.",
        name: "David Martinez",
        rating: 5,
        role: "Architect",
        avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=David",
    },
];


export const MOCK_MY_APPOINTMENTS: AppointmentWithDoctor[] = [
    {
        id: 1,
        appointmentDate: "2026-02-18T10:00:00Z",
        status: "confirmed",
        doctor: {
            id: 1,
            name: "Dr. Sarah Althea, M.Psi",
            specialty: "Psychology",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=SarahDr",
            rating: 4.9,
        },
    },
    {
        id: 2,
        appointmentDate: "2026-02-19T14:00:00Z",
        status: "pending",
        doctor: {
            id: 2,
            name: "Dr. Adrian Wijaya, Sp.KJ",
            specialty: "Psychiatry",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=AdrianDr",
            rating: 5.0,
        },
    },
    {
        id: 3,
        appointmentDate: "2026-02-15T09:00:00Z",
        status: "completed",
        doctor: {
            id: 3,
            name: "Maya Sari, M.Psi",
            specialty: "Counseling",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=MayaDr",
            rating: 4.8,
        },
    },
    {
        id: 4,
        appointmentDate: "2026-02-14T16:00:00Z",
        status: "cancelled",
        doctor: {
            id: 4,
            name: "Budi Santoso, S.Psi",
            specialty: "Clinical",
            avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=BudiDr",
            rating: 4.7,
        },
    },
];
