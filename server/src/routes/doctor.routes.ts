import { Router } from "express";
import { DoctorController } from "../controllers/doctor.controller";
import { authenticate } from "../middleware/auth.middleware";
import { requireDoctor } from "../middleware/role.middleware";
import { validate } from "../middleware/validate.middleware";
import { CreateSlotSchema, CreatePatternSchema } from "../schemas/appointment.schema";
import { idParam } from "../schemas/params.schema";
import { SetAwaySchema } from "../schemas/doctor.schema";

const router = Router();

/*
 * Route order matters: every literal path is registered before the `/:id`
 * catch-all, otherwise `/analytics` is matched as an id of "analytics".
 */

// Literal, role-gated paths first.
router.get("/stats", authenticate, requireDoctor, DoctorController.getStats);
router.get("/analytics", authenticate, requireDoctor, DoctorController.getAnalytics);
router.get("/patterns", authenticate, requireDoctor, DoctorController.getPatterns);
router.get("/packages/my", authenticate, DoctorController.myPackages);
router.post("/packages/:id/purchase", authenticate, validate(idParam), DoctorController.purchasePackage);

// Public discovery.
router.get("/", DoctorController.getAll);
router.get("/slots/:id", validate(idParam), DoctorController.getSlots);

// Waitlist (any authenticated role, scoped to the caller's own patient id).
router.post("/:id/waitlist", authenticate, validate(idParam), DoctorController.joinWaitlist);
router.delete("/:id/waitlist", authenticate, validate(idParam), DoctorController.leaveWaitlist);
router.get("/:id/waitlist/status", authenticate, validate(idParam), DoctorController.waitlistStatus);

// Public per-resource reads.
router.get("/:id/packages", validate(idParam), DoctorController.getPackages);
router.get("/:id", validate(idParam), DoctorController.getById);

/**
 * Every mutation below is doctor-only.
 *
 * These previously gated on `req.user.doctorProfileId` being non-null, which
 * `POST /api/auth/register` grants to anyone who asks for `role: "doctor"` —
 * so an anonymous visitor could self-provision a clinician identity and
 * immediately publish packages, slots and availability. `requireDoctor` is
 * applied at the route so the intent is explicit and cannot be forgotten when
 * a handler is added.
 */
router.post("/packages", authenticate, requireDoctor, DoctorController.createPackage);
router.delete("/packages/:id", authenticate, requireDoctor, validate(idParam), DoctorController.deletePackage);

router.post("/slots", authenticate, requireDoctor, validate(CreateSlotSchema), DoctorController.createSlot);
router.delete("/slots/:id", authenticate, requireDoctor, validate(idParam), DoctorController.deleteSlot);

router.post("/patterns", authenticate, requireDoctor, validate(CreatePatternSchema), DoctorController.createPattern);
router.delete("/patterns/:id", authenticate, requireDoctor, validate(idParam), DoctorController.deletePattern);
router.post("/patterns/:id/regenerate", authenticate, requireDoctor, validate(idParam), DoctorController.regeneratePattern);

router.post("/away", authenticate, requireDoctor, validate(SetAwaySchema), DoctorController.setAway);

export default router;
