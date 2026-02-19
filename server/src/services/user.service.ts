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
        const { name, phone_number, avatar, bio, specialization, price } = data;

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
                    price: parseInt(price) || 0,
                },
                create: {
                    userId: user.id,
                    bio: bio || "",
                    specialty: specialization || "General Psychologist",
                    price: parseInt(price) || 0,
                },
            });
        }

        return user;
    }
}
