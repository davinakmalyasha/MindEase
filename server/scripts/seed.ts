import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { dayKey } from "../src/lib/date";

const prisma = new PrismaClient();

const SPECIALTIES = [
    "Clinical Psychologist",
    "Family Counselor",
    "Trauma Therapist",
    "Addiction Specialist",
    "Child Psychologist",
    "Couples Counselor",
    "Anxiety Specialist",
    "Depression Specialist",
];

const BIOS = [
    "Compassionate, evidence-based therapy tailored to your unique journey toward healing and growth.",
    "I help individuals navigate life transitions, anxiety, and relationships with warmth and practical tools.",
    "Trauma-informed care in a safe, judgment-free space. EMDR and CBT certified.",
    "Supporting recovery with empathy and structure. Harm-reduction and CBT approaches.",
    "Play-based and talk therapy for children and teens, plus parent guidance sessions.",
    "Helping couples rebuild trust, communicate better, and reconnect emotionally.",
    "Specializing in anxiety disorders using exposure therapy and mindfulness techniques.",
    "Depression-focused care combining cognitive restructuring with lifestyle medicine.",
];

const FIRST_NAMES = ["Sarah", "James", "Aisha", "Michael", "Emily", "David", "Laura", "Andi", "Budi", "Siti", "Rina", "Dewa"];
const LAST_NAMES = ["Mitchell", "Carter", "Rahman", "Santoso", "Walker", "Wijaya", "Permata", "Hidayat", "Putri", "Nugroho", "Sari", "Kusuma"];

const timeToMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
};

async function main() {
    const admin = await prisma.user.upsert({
        where: { email: "admin@mindease.app" },
        update: {},
        create: {
            email: "admin@mindease.app",
            password: await argon2.hash("Admin@123"),
            name: "System Admin",
            role: "admin",
            provider: "local",
        },
    });
    console.log("Admin ready:", admin.email);

    const patient = await prisma.user.upsert({
        where: { email: "patient@mindease.app" },
        update: {},
        create: {
            email: "patient@mindease.app",
            password: await argon2.hash("Patient@123"),
            name: "Demo Patient",
            role: "patient",
            phone_number: "+6281234567890",
            provider: "local",
        },
    });
    console.log("Patient ready:", patient.email);

    for (let i = 0; i < 8; i++) {
        const email = `dr${i + 1}@mindease.app`;
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) continue;

        const name = `Dr. ${FIRST_NAMES[i]} ${LAST_NAMES[i]}`;
        const user = await prisma.user.create({
            data: {
                email,
                password: await argon2.hash("Doctor@123"),
                name,
                role: "doctor",
                phone_number: `+62811${String(10000000 + i * 1111111)}`,
                provider: "local",
                avatar: `https://api.dicebear.com/9.x/avataaars/svg?seed=${FIRST_NAMES[i]}`,
            },
        });

        const doctor = await prisma.doctor.create({
            data: {
                userId: user.id,
                specialty: SPECIALTIES[i],
                bio: BIOS[i],
                experience: 3 + (i % 12),
                price: 150000 + i * 75000,
                // `rating` and `totalReviews` are deliberately left at their
                // defaults. This seed previously invented a 4.2–4.9 rating for
                // every clinician with zero reviews, which is exactly the
                // fabricated-5.0 policy that `ReviewService.recalcDoctorRating`
                // and the `Doctor.rating` column comment exist to prevent — and
                // it made the "Top Rated" sort rank the most-liked-looking
                // profiles first. Demo data should not model the bug.
                availability: i % 3 === 0 ? "Busy" : "Available",
                verificationStatus: "approved",
                licenseNumber: `STR-DEMO-${100000 + i}`,
                licenseIssuer: "Demo Psychology Board",
            },
        });

        // Create open slots for the next 7 days
        const startHour = 8 + (i % 6);
        for (let day = 1; day <= 7; day++) {
            const date = new Date();
            date.setDate(date.getDate() + day);
            date.setHours(0, 0, 0, 0);

            for (let s = startHour; s < startHour + 3; s++) {
                const startTime = `${String(s).padStart(2, "0")}:00`;
                const endTime = `${String(s + 1).padStart(2, "0")}:00`;
                await prisma.consultationSlot.create({
                    data: {
                        doctorId: doctor.id,
                        date,
                        startTime,
                        endTime,
                        isBooked: false,
                    },
                });
            }
        }
        console.log("Doctor ready:", name, `(${SPECIALTIES[i]})`);
    }

    // Seed mood history for the demo patient
    const moodCount = await prisma.moodEntry.count({ where: { userId: patient.id } });
    if (moodCount === 0) {
        // `moodDate` is NOT NULL and carries a unique (userId, moodDate) key, so
        // every insert must supply the calendar day in the *user's* timezone.
        // Omitting it made `npm run db:seed` — step 2 of the documented quick
        // start — throw, and the fourteen days of demo history with it.
        const timezone = patient.timezone || "Asia/Jakarta";
        for (let i = 13; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(18 + (i % 3), 0, 0, 0);
            await prisma.moodEntry.create({
                data: {
                    userId: patient.id,
                    mood: 2 + ((i * 7) % 4),
                    notes: ["Feeling productive today.", "A bit anxious about work.", "Enjoyed time with family.", ""][i % 4],
                    createdAt: date,
                    moodDate: dayKey(date, timezone),
                    factors: JSON.stringify([["sleep", "exercise", "social", "work", "stress"][i % 5]]),
                },
            });
        }
        console.log("Seeded 14 days of mood history for", patient.email);
    }

    // A risk queue with nothing in it is a screenshot of an empty table, and it
    // is the wrong first impression of the screen this repository is built
    // around. The README's central claim is that a disclosure reaches a named
    // clinician; a fresh clone could not demonstrate that, because `make up`
    // seeded accounts, mood entries and availability but never a single
    // RiskAlert. The queue was therefore always empty on arrival.
    //
    // Four alerts, chosen so the queue demonstrates the distinctions the
    // implementation makes rather than just filling space:
    //
    //   - urgent, unseen, from the SOS button. Nothing has touched it.
    //   - elevated, acknowledged 3 days ago and still unresolved. This is the
    //     case the schema's two-timestamp split exists for: seen on Monday,
    //     still owed an outcome on Friday.
    //   - elevated, unseen, from a PHQ-9 item 9 response.
    //   - urgent, resolved with a note. Present so "show resolved" has
    //     something to show, and so the audit trail is visible.
    //
    // All four are assigned to dr1 so a demo clinician sees a full queue rather
    // than an empty one.
    const riskCount = await prisma.riskAlert.count();
    if (riskCount === 0) {
        const dr1 = await prisma.user.findUnique({ where: { email: "dr1@mindease.app" } });
        if (dr1) {
            const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

            await prisma.riskAlert.createMany({
                data: [
                    {
                        userId: patient.id,
                        level: "urgent",
                        reason:
                            "Patient pressed the SOS button and wrote: I don't want to be here anymore. No clinician had responded at the time it was sent.",
                        sourceType: "sos",
                        notifiedDoctorUserId: dr1.id,
                        assignedDoctorUserId: dr1.id,
                        createdAt: daysAgo(0),
                    },
                    {
                        userId: patient.id,
                        level: "elevated",
                        reason:
                            "Answered yes to PHQ-9 item 9 (thoughts of being better off dead or of hurting themselves) on the intake screening.",
                        sourceType: "phq9",
                        // Acknowledged three days ago and deliberately left
                        // unresolved: the queue's whole argument is that
                        // "seen" and "dealt with" are different acts.
                        acknowledgedAt: daysAgo(3),
                        acknowledgedById: dr1.id,
                        notifiedDoctorUserId: dr1.id,
                        assignedDoctorUserId: dr1.id,
                        createdAt: daysAgo(4),
                    },
                    {
                        userId: patient.id,
                        level: "elevated",
                        reason:
                            "Message contained crisis phrasing: \"I have been thinking about disappearing and nobody would notice.\"",
                        sourceType: "message",
                        notifiedDoctorUserId: dr1.id,
                        assignedDoctorUserId: dr1.id,
                        createdAt: daysAgo(1),
                    },
                    {
                        userId: patient.id,
                        level: "urgent",
                        reason: "Six consecutive days of low mood entries triggered the decline rule.",
                        sourceType: "mood",
                        notifiedDoctorUserId: dr1.id,
                        assignedDoctorUserId: dr1.id,
                        acknowledgedAt: daysAgo(6),
                        acknowledgedById: dr1.id,
                        resolvedAt: daysAgo(5),
                        resolvedById: dr1.id,
                        resolutionNote:
                            "Called and spoke with them for 25 minutes. Agreed a safety plan and a check-in on Thursday. Crisis line numbers given as well.",
                        createdAt: daysAgo(7),
                    },
                ],
            });

            console.log("Seeded 4 risk alerts for dr1@mindease.app (3 open, 1 resolved)");
        }
    }

    console.log("\nSeed complete.");
    console.log("Accounts:");
    console.log("  admin@mindease.app / Admin@123");
    console.log("  patient@mindease.app / Patient@123");
    console.log("  dr1@mindease.app ... dr8@mindease.app / Doctor@123");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
