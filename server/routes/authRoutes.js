const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

const {
  validate,
  registerSchema,
  loginSchema,
} = require("../middleware/validators");
router.post("/register", validate(registerSchema), authController.register);
router.post("/login", validate(loginSchema), authController.login);

module.exports = router;
