"use client";

import { useState, useEffect } from 'react';
import api from '../../../utils/api';
import { useRouter } from 'next/navigation';

export default function AppointmentHistory() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [appointments, setAppointments] = useState([]);

  const fetchAppointments = async (id, role) => {
    try {
      const res = await api.get(`/appointments?userId=${id}&role=${role}`);
      setAppointments(res.data);
    } catch (err) {
      console.error('Gagal ambil data:', err);
    }
  };

  const handleStatusUpdate = async (id, newStatus) => {
    if(!confirm(`Ubah status jadi ${newStatus}?`)) return;
    try {
      await api.put(`/appointments/${id}`, { status: newStatus });
      const userData = JSON.parse(localStorage.getItem('user'));
      fetchAppointments(userData.id, userData.role);
    } catch (err) {
      alert('Gagal update status');
    }
  };

  const handleReview = async (appointment) => {
    const ratingStr = prompt("Beri Rating (1-5):", "5");
    if (!ratingStr) return; 

    const rating = parseInt(ratingStr);
    if (rating < 1 || rating > 5) return alert("Rating harus 1-5!");

    const comment = prompt("Tulis komentar pengalaman Anda:", "Dokternya ramah banget!");
    if (!comment) return;

    try {
       await api.post('/reviews', {
         appointment_id: appointment.id,
         doctor_id: appointment.doctor_id, 
         rating: rating,
         comment: comment
       });

       alert("Review berhasil dikirim!");
       const userData = JSON.parse(localStorage.getItem('user'));
       fetchAppointments(userData.id, userData.role);

    } catch (err) {
       alert("Gagal review: " + (err.response?.data?.message || err.message));
    }
  };

  useEffect(() => {
    const userData = JSON.parse(localStorage.getItem('user'));
    if (!userData) {
      router.push('/login');
    } else {
      setUser(userData);
      fetchAppointments(userData.id, userData.role);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user) return <p>Loading...</p>;

  return (
    <div>
      <button onClick={() => router.back()}>← Kembali ke Dashboard</button>
      
      <h1>Riwayat Konsultasi</h1>
      
      {appointments.length === 0 ? (
        <p>Belum ada jadwal konsultasi.</p>
      ) : (
        <table border="1">
          <thead>
            <tr>
              <th>Tanggal</th>
              <th>Jam</th>
              <th>{user.role === 'doctor' ? 'Nama Pasien' : 'Nama Dokter'}</th>
              <th>Keluhan</th>
              <th>Status</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((item) => (
              <tr key={item.id}>
                <td>{item.date ? item.date.split('T')[0] : 'N/A'}</td>
                <td>{item.start_time?.slice(0,5)} - {item.end_time?.slice(0,5)}</td>
                
                <td>
                    {user.role === 'doctor' ? item.patient_name : item.doctor_name}
                </td>
                
                <td>{item.complaint}</td>
                
                <td>
                  <span>
                    {item.status.toUpperCase()}
                  </span>
                </td>

                <td>
                  {user.role === 'doctor' && (
                    <>
                      {item.status === 'pending' && (
                         <>
                           <button onClick={() => handleStatusUpdate(item.id, 'confirmed')}>Terima</button>
                           <button onClick={() => handleStatusUpdate(item.id, 'cancelled')}>Tolak</button>
                         </>
                      )}
                      {item.status === 'confirmed' && (
                           <button onClick={() => handleStatusUpdate(item.id, 'completed')}>Selesai</button>
                      )}
                    </>
                  )}

                  {user.role === 'patient' && item.status === 'completed' && (
                      <button onClick={() => handleReview(item)}>
                        ⭐ Beri Ulasan
                      </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}