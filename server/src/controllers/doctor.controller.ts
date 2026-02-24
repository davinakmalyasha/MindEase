import { Request, Response } from "express";
import { DoctorService } from "../services/doctor.service";

export class DoctorController {
    static async getAll(req: Request, res: Response) {
        try {
            const doctors = await DoctorService.getAllDoctors();
            res.json({ status: "success", data: doctors });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getById(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const doctor = await DoctorService.getDoctorById(parseInt(id));
            if (!doctor) {
                return res.status(404).json({ status: "error", message: "Doctor not found" });
            }
            res.json({ status: "success", data: doctor });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getStats(req: Request, res: Response) {
        try {
            // @ts-ignore
            const doctorId = req.user?.doctorProfile?.id || req.user?.id;
            const stats = await DoctorService.getDoctorStats(doctorId);
            res.json({ status: "success", data: stats });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getSlots(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            const slots = await DoctorService.getSlots(doctorId);
            res.json(slots); // Match frontend expectation of direct array or wrapped
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async createSlot(req: Request, res: Response) {
        try {
            const slot = await DoctorService.createSlot(req.body);
            res.status(201).json(slot);
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async deleteSlot(req: Request, res: Response) {
        try {
            const slotId = parseInt(req.params.id as string);
            const doctorId = (req as any).user?.doctorProfile?.id || (req as any).user?.id;
            const result = await DoctorService.deleteSlot(slotId, doctorId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to delete slot.";
            res.status(400).json({ status: "error", message });
        }
    }
}
