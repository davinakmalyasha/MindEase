import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

interface AuthRequest extends Request {
    user?: { id: number; role: string; email: string };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const token = req.cookies.accessToken || req.headers.authorization?.split(" ")[1];

    if (!token) {
        console.warn("[Auth Middleware] No token found in cookies or headers");
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };

        // Fetch full user to get role
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, role: true, email: true }
        });

        if (!user) {
            console.error("[Auth Middleware] User not found for ID:", decoded.userId);
            return res.status(401).json({ status: "error", message: "User not found" });
        }

        req.user = user;
        next();
    } catch (error: any) {
        console.error("[Auth Middleware] Token verification failed:", error.message);
        return res.status(401).json({ status: "error", message: "Invalid Token" });
    }
};
