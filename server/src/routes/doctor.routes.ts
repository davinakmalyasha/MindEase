import { Router } from "express";
import { DoctorController } from "../controllers/doctor.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { CreateSlotSchema } from "../schemas/appointment.schema";

const router = Router();

router.get("/", DoctorController.getAll);
router.get("/stats", authenticate, DoctorController.getStats);
router.get("/slots/:id", DoctorController.getSlots);

router.get("/:id", DoctorController.getById);

// Slot management (doctor only)
router.post("/slots", authenticate, validate(CreateSlotSchema), DoctorController.createSlot);
router.delete("/slots/:id", authenticate, DoctorController.deleteSlot);

export default router;
