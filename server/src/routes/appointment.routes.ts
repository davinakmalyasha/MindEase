import { Router } from "express";
import { AppointmentController } from "../controllers/appointment.controller";
import { authenticate } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { BookAppointmentSchema, UpdateStatusSchema } from "../schemas/appointment.schema";
import { RescheduleSchema } from "../schemas/auth.schema";

const router = Router();

router.use(authenticate);

router.post("/book", validate(BookAppointmentSchema), AppointmentController.book);
router.get("/my", AppointmentController.getMy);
router.get("/:id/rebook-options", AppointmentController.rebookOptions);
router.get("/:id/ics", AppointmentController.getIcs);
router.post("/:id/join", AppointmentController.joinRoom);
router.put("/:id/status", validate(UpdateStatusSchema), AppointmentController.updateStatus);
router.put("/:id/reschedule", validate(RescheduleSchema), AppointmentController.reschedule);

export default router;
