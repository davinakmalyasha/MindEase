const express = require("express");
const router = express.Router();
const doctorController = require("../controllers/doctorController");
const authMiddleware = require("../middleware/authMiddleware");
const verifyRole = require("../middleware/roleMiddleware");

router.post(
  "/slots",
  authMiddleware,
  verifyRole(["doctor"]),
  doctorController.addSlot,
);
router.get("/slots/:doctorId", authMiddleware, doctorController.getSlots);

module.exports = router;
