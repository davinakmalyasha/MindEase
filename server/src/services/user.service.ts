import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class UserService {
    static async getProfile(userId: number) {
        return await prisma.user.findUnique({
            where: { id: userId },
            include: {
                doctorProfile: true,
            },
        });
    }

    static async updateProfile(userId: number, data: any) {
        if (!data) throw new Error("Data is undefined");
        const { name, phone_number, avatar, bio, specialization, price, consultation_fee } = data;

        // fee can come as consultation_fee from UI or price from other places
        const finalPrice = price || consultation_fee;

        const user = await prisma.user.update({
            where: { id: userId },
            data: {
                name,
                phone_number,
                avatar,
            },
        });

        if (user.role === "doctor") {
            await prisma.doctor.upsert({
                where: { userId: user.id },
                update: {
                    bio,
                    specialty: specialization,
                    price: parseInt(finalPrice) || 0,
                },
                create: {
                    userId: user.id,
                    bio: bio || "",
                    specialty: specialization || "General Psychologist",
                    price: parseInt(finalPrice) || 0,
                },
            });
        }

        return user;
    }
}
