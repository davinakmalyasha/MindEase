import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies.accessToken || req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                role: true,
                email: true,
                isBanned: true,
                doctorProfile: { select: { id: true } },
            },
        });

        if (!user) {
            return res.status(401).json({ status: "error", message: "User not found" });
        }

        if (user.isBanned) {
            return res.status(403).json({ status: "error", message: "Account suspended. Contact support." });
        }

        req.user = {
            id: user.id,
            role: user.role,
            email: user.email,
            doctorProfileId: user.doctorProfile?.id ?? null,
        };
        next();
    } catch (error: any) {
        console.error("[Auth Middleware] Token verification failed:", error.message);
        return res.status(401).json({ status: "error", message: "Invalid Token" });
    }
};
