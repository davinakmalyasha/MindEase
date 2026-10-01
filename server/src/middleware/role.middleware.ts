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

/**
 * Clinician or administrator.
 *
 * Used by the clinical-safety surfaces, where an admin is a legitimate
 * participant rather than a privilege escalation. `RiskAlert.assignedDoctorUserId`
 * documents the case directly: an alert raised at 23:00 may page the on-call
 * admin, and that admin still has to be able to open it. `RiskQueueService` has
 * always had an `isAdmin` branch for exactly this, but the route was guarded
 * with `requireDoctor`, so the branch was unreachable and an admin got a 403
 * on the one queue they are paged from.
 *
 * The risk that a general-purpose helper quietly widens access is why this is
 * named for the specific pairing rather than being expressed as an
 * "allow any of these roles" array. Adding a third role here should be a
 * deliberate decision with a test behind it.
 */
export const requireClinicalStaff = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ status: "error", message: "Unauthorized" });
    }
    if (req.user.role !== "doctor" && req.user.role !== "admin") {
        return res
            .status(403)
            .json({ status: "error", message: "Forbidden: clinician access required" });
    }
    next();
};
