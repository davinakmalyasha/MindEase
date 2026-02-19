import { DOCTORS } from "@/lib/data/doctors";
import { notFound } from "next/navigation";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import DoctorProfile from "@/components/doctors/DoctorProfile";

// Mock reviews data (could also be fetched from a server in the future)
const MOCK_REVIEWS = [
    {
        id: 1,
        name: "Ahmad Fauzi",
        avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Ahmad",
        rating: 5,
        date: "Feb 10, 2026",
        comment: "Sangat membantu dalam memahami kondisi kecemasan saya. Penjelasan yang diberikan sangat tenang dan mudah dimengerti."
    },
    {
        id: 2,
        name: "Siti Aminah",
        avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Siti",
        rating: 5,
        date: "Jan 28, 2026",
        comment: "Dr. Sarah Mitchell sangat profesional dan empatik. Saya merasa didengarkan sepenuhnya."
    },
    {
        id: 3,
        name: "Budi Pratama",
        avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Pratama",
        rating: 4,
        date: "Jan 15, 2026",
        comment: "Sesi konsultasi yang produktif. Ruangannya nyaman dan platformnya lancar."
    }
];

export default async function DoctorDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const doctorId = parseInt(id);
    const doctor = DOCTORS.find(d => d.id === doctorId);

    if (!doctor) {
        notFound();
    }

    return (
        <main className="min-h-screen bg-white">
            <Navbar />
            <DoctorProfile doctor={doctor} reviews={MOCK_REVIEWS} />
            <Footer />
        </main>
    );
}
