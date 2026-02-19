export const SPECIALTIES = [
    "All",
    "Psychology",
    "Psychiatry",
    "Counseling",
    "Pediatric",
    "Neuropsychology",
    "Clinical",
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export interface Doctor {
    id: number;
    name: string;
    specialty: Specialty;
    avatar: string;
    image?: string; // Added for UI compatibility
    rating: number;
    reviewCount: number;
    experience: number;
    isAvailable: boolean;
    isVerified: boolean;
    bio: string;
    price: number;
    availability?: string;
}

export interface AppointmentWithDoctor {
    id: number;
    appointmentDate: string;
    status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
    notes?: string;
    consultationType?: string;
    startTime?: string;
    endTime?: string;
    doctor: {
        id: number;
        name: string;
        specialty: string;
        avatar: string;
        rating: number;
        user?: {
            name?: string;
            avatar?: string;
            phone_number?: string;
        };
    };
    user?: {
        name: string;
        avatar: string;
        phone_number?: string;
    };
}

export interface FilterParams {
    search: string;
    specialty: Specialty;
    minExperience: number;
    availableOnly: boolean;
    page: number;
}
