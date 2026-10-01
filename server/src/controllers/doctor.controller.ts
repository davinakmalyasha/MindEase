import { Request, Response } from "express";
import { DoctorService } from "../services/doctor.service";
import { WaitlistService } from "../services/waitlist.service";
import { publicMessageFor } from "../utils/appError";

export class DoctorController {
    static async getAll(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
            const num = (v: string | undefined) => {
                if (v === undefined || v === "") return undefined;
                const n = Number(v);
                return Number.isFinite(n) ? n : undefined;
            };
            const sort = ["rating", "price_asc", "price_desc", "experience"].includes(req.query.sort as string)
                ? (req.query.sort as any)
                : undefined;
            const doctors = await DoctorService.getAllDoctors(page, limit, {
                q: (req.query.q as string) || undefined,
                specialty: (req.query.specialty as string) || undefined,
                priceMin: num(req.query.priceMin as string),
                priceMax: num(req.query.priceMax as string),
                minExperience: num(req.query.minExperience as string),
                availableOnly: req.query.availableOnly === "true",
                sort,
            });
            res.json({ status: "success", data: doctors });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async getSpecialties(req: Request, res: Response) {
        try {
            const specialties = await DoctorService.getSpecialties();
            res.json({ status: "success", data: specialties });
        } catch (error: any) {
            const { message, status } = publicMessageFor(error) ?? {
                message: "Something went wrong. Please try again.",
                status: 500,
            };
            res.status(status).json({ status: "error", message });
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
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
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
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
        }
    }

    static async getAnalytics(req: Request, res: Response) {
        try {
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const analytics = await DoctorService.getDoctorAnalytics(doctorId);
            res.json({ status: "success", data: analytics });
        } catch (error: any) {
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
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
            res.status(500).json({ status: "error", message: publicMessageFor(error)?.message ?? "Something went wrong. Please try again."});
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
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to create slot.", status: 400 };
            res.status(status).json({ status: "error", message });
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
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to delete slot.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async createPattern(req: Request, res: Response) {
        try {
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const result = await DoctorService.createPattern(doctorId, {
                weekday: req.body.weekday,
                start_time: req.body.start_time,
                end_time: req.body.end_time,
                activeFrom: req.body.activeFrom,
                weeks: req.body.weeks,
            });
            res.status(201).json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to create pattern.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getPatterns(req: Request, res: Response) {
        try {
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const patterns = await DoctorService.getPatterns(doctorId);
            res.json({ status: "success", data: patterns });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch patterns.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async deletePattern(req: Request, res: Response) {
        try {
            const patternId = parseInt(req.params.id as string);
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const result = await DoctorService.deletePattern(patternId, doctorId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to delete pattern.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async joinWaitlist(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            const entry = await WaitlistService.join(doctorId, req.user!.id);
            res.status(201).json({ status: "success", data: entry });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to join waitlist.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async leaveWaitlist(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            const result = await WaitlistService.leave(doctorId, req.user!.id);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to leave waitlist.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async waitlistStatus(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            const status = await WaitlistService.status(doctorId, req.user!.id);
            res.json({ status: "success", data: status });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch waitlist status.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async setAway(req: Request, res: Response) {
        try {
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            // `SetAwaySchema` makes the key required, so this is an explicit
            // decision: a date sets the window, `null` clears it. A body of `{}`
            // is now a 400 instead of quietly clearing a clinician's away mode.
            const result = await DoctorService.setAway(doctorId, req.body.awayUntil ?? null);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to update away mode.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async regeneratePattern(req: Request, res: Response) {
        try {
            const patternId = parseInt(req.params.id as string);
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const result = await DoctorService.regeneratePattern(patternId, doctorId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to regenerate pattern.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async createPackage(req: Request, res: Response) {
        try {
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const pkg = await DoctorService.createPackage(doctorId, {
                name: req.body.name,
                description: req.body.description,
                sessionCount: req.body.sessionCount,
                totalPrice: req.body.totalPrice,
            });
            res.status(201).json({ status: "success", data: pkg });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to create package.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async getPackages(req: Request, res: Response) {
        try {
            const doctorId = parseInt(req.params.id as string);
            const packages = await DoctorService.getPackages(doctorId, true);
            res.json({ status: "success", data: packages });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch packages.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async deletePackage(req: Request, res: Response) {
        try {
            const packageId = parseInt(req.params.id as string);
            const doctorId = req.user!.doctorProfileId;
            if (!doctorId) {
                return res.status(400).json({ status: "error", message: "Doctor profile not found" });
            }
            const result = await DoctorService.deletePackage(packageId, doctorId);
            res.json({ status: "success", data: result });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to delete package.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async purchasePackage(req: Request, res: Response) {
        try {
            const packageId = Number(req.params.id);

            // A patient cannot grant themselves a package. Until the payment
            // provider is wired up (Wave 3) the only legitimate path is an
            // administrator granting an entitlement on the patient's behalf.
            const isAdmin = req.user!.role === "admin";
            const purchase = await DoctorService.purchasePackage(packageId, req.user!.id, {
                grantedByUserId: isAdmin ? req.user!.id : null,
            });
            res.status(201).json({ status: "success", data: purchase });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to purchase package.", status: 400 };
            res.status(status).json({ status: "error", message });
        }
    }

    static async myPackages(req: Request, res: Response) {
        try {
            const purchases = await DoctorService.getMyPackagePurchases(req.user!.id);
            res.json({ status: "success", data: purchases });
        } catch (error: unknown) {
            const { message, status } = publicMessageFor(error) ?? { message: "Failed to fetch packages.", status: 500 };
            res.status(status).json({ status: "error", message });
        }
    }
}
