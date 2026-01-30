const db = require('../config/db');

exports.getAllDoctors = async (req, res) => {
    try {
        const query = `
            SELECT u.id, u.name, u.phone_number, dp.specialization, dp.consultation_fee 
            FROM users u 
            JOIN doctor_profiles dp ON u.id = dp.user_id 
            WHERE u.role = 'doctor'
        `;
        const [doctors] = await db.query(query);
        res.json(doctors);
    } catch (error) {
        res.status(500).json({ message: 'Gagal ambil data dokter', error });
    }
};
exports.bookAppointment = async (req, res) => {
    const { user_id, slot_id, complaint } = req.body;

    try {
        const [slotCheck] = await db.query('SELECT * FROM consultation_slots WHERE id = ? AND status = "available"', [slot_id]);
        
        if (slotCheck.length === 0) {
            return res.status(400).json({ message: 'Maaf, slot ini baru saja diambil orang lain!' });
        }

        const slot = slotCheck[0];
        await db.query('UPDATE consultation_slots SET status = "booked" WHERE id = ?', [slot_id]);

        await db.query(
            'INSERT INTO appointments (user_id, slot_id, complaint, status) VALUES (?, ?, ?, ?)',
            [user_id, slot_id, complaint, 'pending']
        );

        const [doctorData] = await db.query('SELECT phone_number, name FROM users WHERE id = ?', [slot.doctor_id]);
        const doctor = doctorData[0];

        res.json({ 
            message: 'Booking Berhasil!', 
            doctor_wa: doctor.phone_number,
            doctor_name: doctor.name
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Gagal booking', error });
    }
};