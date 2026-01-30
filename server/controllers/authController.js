const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// LOGIC REGISTER
exports.register = async (req, res) => {
  const { name, email, password, phone_number, role } = req.body;

  try {
    const [existingUser] = await db.query(
      "SELECT * FROM users WHERE email = ?",
      [email],
    );
    if (existingUser.length > 0) {
      return res.status(400).json({ message: "Email sudah terdaftar!" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const userRole = role || "patient";

    await db.query(
      "INSERT INTO users (name, email, password, phone_number, role) VALUES (?, ?, ?, ?, ?)",
      [name, email, hashedPassword, phone_number, userRole],
    );

    res.status(201).json({ message: "Registrasi berhasil! Silakan login." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);

    if (users.length === 0) {
      return res.status(404).json({ message: "Email tidak ditemukan." });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Password salah!" });
    }
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    res.json({
      message: "Login berhasil",
      token: token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};
