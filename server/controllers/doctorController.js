const db = require('../config/db');

exports.getSlots = async (req, res) => {
    const doctorId = req.params.doctorId; 

    try {
        const [slots] = await db.query(
            'SELECT * FROM consultation_slots WHERE doctor_id = ? ORDER BY date, start_time',
            [doctorId]
        );
        res.json(slots);
    } catch (error) {
        res.status(500).json({ message: 'Error mengambil jadwal', error });
    }
};

exports.addSlot = async (req, res) => {
    const { doctor_id, date, start_time, end_time } = req.body;

    try {
        if (end_time <= start_time) {
            return res.status(400).json({ message: 'Jam selesai harus lebih akhir dari jam mulai!' });
        }

        await db.query(
            'INSERT INTO consultation_slots (doctor_id, date, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)',
            [doctor_id, date, start_time, end_time, 'available']
        );

        res.status(201).json({ message: 'Slot berhasil dibuat!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Gagal membuat slot', error });
    }
};