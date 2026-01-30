const db = require("../config/db");

exports.createReview = async (req, res) => {
  const { appointment_id, doctor_id, rating, comment } = req.body;
  const patient_id = req.user.id;

  try {
    const [cek] = await db.query(
      "SELECT status FROM appointments WHERE id = ?",
      [appointment_id],
    );
    if (cek.length === 0 || cek[0].status !== "completed") {
      return res
        .status(400)
        .json({ message: "Konsultasi belum selesai, belum bisa review!" });
    }

    const [ada] = await db.query(
      "SELECT * FROM reviews WHERE appointment_id = ?",
      [appointment_id],
    );
    if (ada.length > 0) {
      return res.status(400).json({ message: "Anda sudah mereview sesi ini!" });
    }

    await db.query(
      "INSERT INTO reviews (appointment_id, doctor_id, patient_id, rating, comment) VALUES (?, ?, ?, ?, ?)",
      [appointment_id, doctor_id, patient_id, rating, comment],
    );

    res.status(201).json({ message: "Terima kasih atas ulasannya!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Gagal kirim review" });
  }
};

exports.getDoctorReviews = async (req, res) => {
  const { doctorId } = req.params;
  try {
    const [reviews] = await db.query(
      `
            SELECT r.rating, r.comment, r.created_at, u.name as patient_name 
            FROM reviews r
            JOIN users u ON r.patient_id = u.id
            WHERE r.doctor_id = ?
            ORDER BY r.created_at DESC
        `,
      [doctorId],
    );

    res.json(reviews);
  } catch (error) {
    res.status(500).json({ message: "Error ambil review" });
  }
};
