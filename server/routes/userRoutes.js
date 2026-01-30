const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const authMiddleware = require("../middleware/authMiddleware");

router.get("/profile", authMiddleware, userController.getProfile);

router.put(
  "/profile",
  authMiddleware,
  userController.upload.single("avatar"),
  userController.updateProfile,
);

module.exports = router;
