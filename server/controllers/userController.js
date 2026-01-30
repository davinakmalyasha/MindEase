const db = require("../config/db");
const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Hanya boleh upload gambar!"), false);
  }
};

exports.upload = multer({ storage: storage, fileFilter: fileFilter });

exports.updateProfile = async (req, res) => {
  const userId = req.user.id;
  const { name, phone_number, bio, specialization, consultation_fee } =
    req.body;

  let avatarQuery = "";
  let params = [name, phone_number, userId];

  if (req.file) {
    const avatarUrl = `http://localhost:5000/uploads/${req.file.filename}`;
    avatarQuery = `, avatar = '${avatarUrl}'`;
  }

  try {
    await db.query(
      `UPDATE users SET name = ?, phone_number = ? ${avatarQuery} WHERE id = ?`,
      params,
    );
    if (bio || specialization) {
      await db.query(
        `UPDATE doctor_profiles SET bio = ?, specialization = ?, consultation_fee = ? WHERE user_id = ?`,
        [bio, specialization, consultation_fee, userId],
      );
    }

    const [updatedUser] = await db.query("SELECT * FROM users WHERE id = ?", [
      userId,
    ]);

    res.json({
      message: "Profile berhasil diupdate!",
      user: updatedUser[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Gagal update profile", error });
  }
};

exports.getProfile = async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await db.query(
      `
            SELECT u.*, dp.specialization, dp.bio, dp.consultation_fee 
            FROM users u 
            LEFT JOIN doctor_profiles dp ON u.id = dp.user_id 
            WHERE u.id = ?
        `,
      [userId],
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Error server" });
  }
};
