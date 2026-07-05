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
            const id = parseInt(req.params.id as string);
            if (!id) {
                return res.status(400).json({ status: "error", message: "Invalid doctor id" });
            }
            const doctor = await DoctorService.getDoctorById(id);
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
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const stats = await DoctorService.getDoctorStats(doctorId);
            res.json({ status: "success", data: stats });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async getSlots(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Invalid doctor id" });
            }
            const slots = await DoctorService.getSlots(doctorId);
            res.json({ status: "success", data: slots });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: error.message });
        }
    }

    static async createSlot(req: Request, res: Response) {
        try {
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const slot = await DoctorService.createSlot({
                doctorId,
                date: req.body.date,
                start_time: req.body.start_time,
                end_time: req.body.end_time,
            });
            res.status(201).json({ status: "success", data: slot });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to create slot.";
            res.status(400).json({ status: "error", message });
        }
    }

    static async deleteSlot(req: Request, res: Response) {
        try {
            const slotId = parseInt(req.params.id as string);
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const result = await DoctorService.deleteSlot(slotId, doctorId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to delete slot.";
            res.status(400).json({ status: "error", message });
        }
    }
}
