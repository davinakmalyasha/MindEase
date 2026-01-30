const express = require("express");
const router = express.Router();
const appointmentController = require("../controllers/appointmentController");

router.get("/", appointmentController.getMyAppointments);

router.put("/:id", appointmentController.updateStatus);

module.exports = router;
