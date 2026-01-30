const db = require("../config/db");

exports.getMyAppointments = async (req, res) => {
  const { userId, role } = req.query;

  try {
    let query = "";
    let params = [];

    if (role === "patient") {
      query = `
                SELECT 
                    a.id, 
                    a.status, 
                    a.complaint,
                    s.date, 
                    s.start_time, 
                    s.end_time,
                    s.doctor_id, 
                    u.name AS doctor_name, 
                    u.phone_number AS doctor_phone
                FROM appointments a
                JOIN consultation_slots s ON a.slot_id = s.id
                JOIN users u ON s.doctor_id = u.id
                WHERE a.user_id = ?
                ORDER BY s.date DESC, s.start_time ASC
            `;
      params = [userId];
    } else if (role === "doctor") {
      query = `
                SELECT 
                    a.id, 
                    a.status, 
                    a.complaint,
                    s.date, 
                    s.start_time, 
                    s.end_time,
                    u.name AS patient_name, 
                    u.phone_number AS patient_phone
                FROM appointments a
                JOIN consultation_slots s ON a.slot_id = s.id
                JOIN users u ON a.user_id = u.id
                WHERE s.doctor_id = ?
                ORDER BY s.date DESC, s.start_time ASC
            `;
      params = [userId];
    }

    const [results] = await db.query(query, params);
    res.json(results);
  } catch (error) {
    console.error("SQL Error:", error);
    res.status(500).json({ message: "Gagal ambil riwayat", error });
  }
};

exports.updateStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    await db.query("UPDATE appointments SET status = ? WHERE id = ?", [
      status,
      id,
    ]);
    res.json({ message: "Status berhasil diperbarui" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Gagal update status" });
  }
};
