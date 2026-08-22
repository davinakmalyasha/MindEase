import { prisma } from "../lib/prisma";
import { invalidateDoctorCache } from "./doctor.service";
import crypto from "crypto";



export class UserService {
    static async getProfile(userId: number) {
        const profile = await prisma.user.findUnique({
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
                weeklyReportEnabled: true,
                referralCode: true,
                sessionCredits: true,
                doctorProfile: true,
            },
        });

        // Lazily assign a referral code to accounts created before the feature shipped
        if (profile && !profile.referralCode) {
            const code = `ME-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
            await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
            profile.referralCode = code;
        }

        return profile;
    }

    static async updateProfile(userId: number, data: any, avatarPath?: string) {
        if (!data) throw new Error("Data is undefined");
        const {
            name,
            phone_number,
            bio,
            specialization,
            price,
            consultation_fee,
            bank_name,
            bank_account,
            bank_holder,
            weekly_report_enabled,
            experience_years,
            license_number,
            license_issuer,
        } = data;

        const finalPrice = price || consultation_fee;

        // E.164 phone validation — the WhatsApp flows deep-link this field
        if (phone_number !== undefined && phone_number !== null && String(phone_number).trim() !== "") {
            if (!/^\+[1-9]\d{7,14}$/.test(String(phone_number).trim())) {
                throw new Error("Phone number must be in international format, e.g. +6281234567890");
            }
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: {
                ...(name !== undefined && { name }),
                ...(phone_number !== undefined && { phone_number }),
                ...(avatarPath !== undefined && { avatar: avatarPath }),
                ...(weekly_report_enabled !== undefined && { weeklyReportEnabled: weekly_report_enabled === true }),
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
                weeklyReportEnabled: true,
                doctorProfile: true,
            },
        });

        if (user.role === "doctor") {
            const licenseUpdate = {
                ...(experience_years !== undefined && { experience: Math.max(0, parseInt(experience_years) || 0) }),
                ...(license_number !== undefined && { licenseNumber: String(license_number).trim() || null }),
                ...(license_issuer !== undefined && { licenseIssuer: String(license_issuer).trim() || null }),
            };
            await prisma.doctor.upsert({
                where: { userId: user.id },
                update: {
                    ...(bio !== undefined && { bio }),
                    ...(specialization !== undefined && { specialty: specialization }),
                    ...(finalPrice !== undefined && { price: parseInt(finalPrice) || 0 }),
                    ...(bank_name !== undefined && { bankName: bank_name }),
                    ...(bank_account !== undefined && { bankAccount: bank_account }),
                    ...(bank_holder !== undefined && { bankHolder: bank_holder }),
                    ...licenseUpdate,
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
            invalidateDoctorCache();
        }

        return user;
    }
}
