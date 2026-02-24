import { Router } from "express";
import { DoctorController } from "../controllers/doctor.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.get("/", DoctorController.getAll);
router.get("/stats", authenticate, DoctorController.getStats);
router.get("/:id", DoctorController.getById);

// Slot management
router.get("/slots/:id", DoctorController.getSlots);
router.post("/slots", authenticate, DoctorController.createSlot);
router.delete("/slots/:id", authenticate, DoctorController.deleteSlot);

export default router;
