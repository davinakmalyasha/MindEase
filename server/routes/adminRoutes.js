const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const authMiddleware = require("../middleware/authMiddleware");
const verifyRole = require("../middleware/roleMiddleware");

router.get(
  "/stats",
  authMiddleware,
  verifyRole(["admin"]),
  adminController.getDashboardStats,
);
router.get(
  "/users",
  authMiddleware,
  verifyRole(["admin"]),
  adminController.getAllUsers,
);

module.exports = router;
