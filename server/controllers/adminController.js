const db = require('../config/db');

exports.getDashboardStats = async (req, res) => {
    try {
        const [patients] = await db.query("SELECT COUNT(*) as total FROM users WHERE role = 'patient'");
        const [doctors] = await db.query("SELECT COUNT(*) as total FROM users WHERE role = 'doctor'");
        const [appointments] = await db.query("SELECT COUNT(*) as total FROM appointments WHERE status IN ('confirmed', 'completed')");

        const [income] = await db.query(`
            SELECT SUM(dp.consultation_fee) as total_omzet 
            FROM appointments a 
            JOIN consultation_slots s ON a.slot_id = s.id 
            JOIN doctor_profiles dp ON s.doctor_id = dp.user_id 
            WHERE a.status = 'completed'
        `);

        res.json({
            total_patients: patients[0].total,
            total_doctors: doctors[0].total,
            successful_bookings: appointments[0].total,
            total_estimated_revenue: income[0].total_omzet || 0
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Gagal ambil data admin', error });
    }
};

exports.getAllUsers = async (req, res) => {
    try {
        const [users] = await db.query("SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC");
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Error server' });
    }
};