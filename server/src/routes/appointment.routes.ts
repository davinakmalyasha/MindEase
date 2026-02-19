import { Router } from "express";
import { AppointmentController } from "../controllers/appointment.controller";
import { authenticate } from "../middleware/auth.middleware";

const router = Router();

router.use(authenticate);

router.post("/book", AppointmentController.book);
router.get("/my", AppointmentController.getMy);
router.put("/:id/status", AppointmentController.updateStatus);

export default router;
