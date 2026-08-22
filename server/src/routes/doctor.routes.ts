import { Router } from "express";
import { DoctorController } from "../controllers/doctor.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { CreateSlotSchema, CreatePatternSchema } from "../schemas/appointment.schema";

const router = Router();

router.get("/", DoctorController.getAll);
router.get("/stats", authenticate, DoctorController.getStats);
router.get("/analytics", authenticate, DoctorController.getAnalytics);
router.get("/slots/:id", DoctorController.getSlots);
router.get("/patterns", authenticate, DoctorController.getPatterns);

router.get("/:id", DoctorController.getById);
router.post("/:id/waitlist", authenticate, DoctorController.joinWaitlist);
router.delete("/:id/waitlist", authenticate, DoctorController.leaveWaitlist);
router.get("/:id/waitlist/status", authenticate, DoctorController.waitlistStatus);
router.get("/:id/packages", DoctorController.getPackages);

// Packages (doctor only)
router.post("/packages", authenticate, DoctorController.createPackage);
router.delete("/packages/:id", authenticate, DoctorController.deletePackage);

// Packages (patient)
router.post("/packages/:id/purchase", authenticate, DoctorController.purchasePackage);
router.get("/packages/my", authenticate, DoctorController.myPackages);

// Slot management (doctor only)
router.post("/slots", authenticate, validate(CreateSlotSchema), DoctorController.createSlot);
router.delete("/slots/:id", authenticate, DoctorController.deleteSlot);

// Weekly availability patterns (doctor only)
router.post("/patterns", authenticate, validate(CreatePatternSchema), DoctorController.createPattern);
router.delete("/patterns/:id", authenticate, DoctorController.deletePattern);
router.post("/patterns/:id/regenerate", authenticate, DoctorController.regeneratePattern);

// Away mode (doctor only)
router.post("/away", authenticate, DoctorController.setAway);

export default router;
