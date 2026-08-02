import { Request, Response, NextFunction } from "express";

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }
    if (req.user.role !== "admin") {
        return res.status(403).json({ status: "error", message: "Forbidden: admin access required" });
    }
    next();
};

export const requireDoctor = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }
    if (req.user.role !== "doctor") {
        return res.status(403).json({ status: "error", message: "Forbidden: doctor access required" });
    }
    next();
};
