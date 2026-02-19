import { Router } from "express";
import { DoctorController } from "../controllers/doctor.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.get("/", DoctorController.getAll);
router.get("/stats", authenticate, DoctorController.getStats);
router.get("/:id", DoctorController.getById);

export default router;
