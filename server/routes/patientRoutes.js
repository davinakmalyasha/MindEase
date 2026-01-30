const express = require("express");
const router = express.Router();
const patientController = require("../controllers/patientController");

router.get("/doctors", patientController.getAllDoctors);
router.post("/book", patientController.bookAppointment);

module.exports = router;
