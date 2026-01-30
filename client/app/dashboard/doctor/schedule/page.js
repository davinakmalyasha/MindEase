"use client";

import { useState, useEffect } from 'react';
import api from '../../../../utils/api'; 
import { useRouter } from 'next/navigation';

export default function DoctorSchedule() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [slots, setSlots] = useState([]); 
  
  const [form, setForm] = useState({
    date: '',
    start_time: '',
    end_time: ''
  });

  const fetchSlots = async (doctorId) => {
    try {
      const res = await api.get(`/doctor/slots/${doctorId}`);
      setSlots(res.data);
    } catch (error) {
      console.error("Gagal ambil jadwal:", error);
    }
  };

  useEffect(() => {
    const userData = JSON.parse(localStorage.getItem('user'));
    
    if (!userData || userData.role !== 'doctor') {
      alert('Halaman ini khusus Dokter!');
      router.push('/dashboard');
      return;
    }

    setUser(userData);
    fetchSlots(userData.id);
    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/doctor/slots', {
        doctor_id: user.id, 
        ...form
      });
      alert('Jadwal berhasil ditambahkan!');
      fetchSlots(user.id);
    } catch (error) {
      alert('Gagal: ' + error.response?.data?.message);
    }
  };

  if (!user) return <p>Loading...</p>;

  return (
    <div>
      <button onClick={() => router.back()}>← Kembali ke Dashboard</button>
      
      <h1>📅 Atur Jadwal Praktek</h1>
      <p>Halo Dr. {user.name}, silakan buka slot konsultasi.</p>

      <div>
        <h3>Tambah Slot Baru</h3>
        <form onSubmit={handleSubmit}>
          
          <label>Tanggal:</label>
          <input type="date" name="date" onChange={handleChange} required />

          <label>Jam Mulai:</label>
          <input type="time" name="start_time" onChange={handleChange} required />

          <label>Jam Selesai:</label>
          <input type="time" name="end_time" onChange={handleChange} required />

          <button type="submit">
            + Buka Slot
          </button>
        </form>
      </div>

      <h3>Jadwal Aktif Anda</h3>
      <table border="1">
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Jam</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {slots.length === 0 ? (
            <tr><td colSpan="3">Belum ada jadwal dibuat.</td></tr>
          ) : (
            slots.map((slot) => (
              <tr key={slot.id}>
                <td>{slot.date.split('T')[0]}</td> 
                <td>{slot.start_time} - {slot.end_time}</td>
                <td>
                    <span>
                        {slot.status.toUpperCase()}
                    </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}