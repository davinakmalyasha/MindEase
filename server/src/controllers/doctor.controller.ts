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
}
