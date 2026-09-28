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
            specialty,
            experience,
            price,
            languages,
            education,
            weeklyReportEnabled,
            licenseNumber,
            licenseIssuer,
            bankName,
            bankAccount,
            bankHolder,
            availability,
            timezone,
        } = data;

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
                // The avatar may only change through the multipart upload, never
                // from a URL supplied in the body.
                ...(avatarPath !== undefined && { avatar: avatarPath }),
                ...(timezone !== undefined && { timezone }),
                ...(weeklyReportEnabled !== undefined && { weeklyReportEnabled }),
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
                timezone: true,
                doctorProfile: true,
            },
        });

        if (user.role === "doctor") {
            const licenseUpdate = {
                ...(experience !== undefined && { experience }),
                ...(licenseNumber !== undefined && { licenseNumber: String(licenseNumber).trim() || null }),
                ...(licenseIssuer !== undefined && { licenseIssuer: String(licenseIssuer).trim() || null }),
                ...(bio !== undefined && { bio: String(bio) }),
                ...(specialty !== undefined && { specialty: String(specialty) }),
                ...(languages !== undefined && { languages: String(languages) || null }),
                ...(education !== undefined && { education: String(education) || null }),
                ...(price !== undefined && { price }),
                ...(bankName !== undefined && { bankName: String(bankName) || null }),
                ...(bankAccount !== undefined && { bankAccount: String(bankAccount) || null }),
                ...(bankHolder !== undefined && { bankHolder: String(bankHolder) || null }),
                ...(availability !== undefined && { availability: String(availability) }),
            };

            await prisma.doctor.upsert({
                where: { userId: user.id },
                update: licenseUpdate,
                create: {
                    userId: user.id,
                    bio: bio || "",
                    specialty: specialty || "General Psychologist",
                    price: price ?? 0,
                    bankName: bankName ?? null,
                    bankAccount: bankAccount ?? null,
                    bankHolder: bankHolder ?? null,
                },
            });
            invalidateDoctorCache();
        }

        return user;
    }
}
