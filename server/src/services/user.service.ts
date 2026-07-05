import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class UserService {
    static async getProfile(userId: number) {
        return await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                avatar: true,
                role: true,
                phone_number: true,
                provider: true,
                createdAt: true,
                doctorProfile: true,
            },
        });
    }

    static async updateProfile(userId: number, data: any, avatarPath?: string) {
        if (!data) throw new Error("Data is undefined");
        const { name, phone_number, bio, specialization, price, consultation_fee, bank_name, bank_account, bank_holder } = data;

        const finalPrice = price || consultation_fee;

        const user = await prisma.user.update({
            where: { id: userId },
            data: {
                ...(name !== undefined && { name }),
                ...(phone_number !== undefined && { phone_number }),
                ...(avatarPath !== undefined && { avatar: avatarPath }),
            },
            select: {
                id: true,
                email: true,
                name: true,
                avatar: true,
                role: true,
                phone_number: true,
                provider: true,
                createdAt: true,
                doctorProfile: true,
            },
        });

        if (user.role === "doctor") {
            await prisma.doctor.upsert({
                where: { userId: user.id },
                update: {
                    ...(bio !== undefined && { bio }),
                    ...(specialization !== undefined && { specialty: specialization }),
                    ...(finalPrice !== undefined && { price: parseInt(finalPrice) || 0 }),
                    ...(bank_name !== undefined && { bankName: bank_name }),
                    ...(bank_account !== undefined && { bankAccount: bank_account }),
                    ...(bank_holder !== undefined && { bankHolder: bank_holder }),
                },
                create: {
                    userId: user.id,
                    bio: bio || "",
                    specialty: specialization || "General Psychologist",
                    price: parseInt(finalPrice) || 0,
                    bankName: bank_name,
                    bankAccount: bank_account,
                    bankHolder: bank_holder,
                },
            });
        }

        return user;
    }
}
