"use client";

import { useState, useEffect } from 'react';
import api from '../../../../utils/api';
import { useRouter } from 'next/navigation';

export default function BookingPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  
  const [doctors, setDoctors] = useState([]); 
  const [selectedDoctor, setSelectedDoctor] = useState(null); 
  const [slots, setSlots] = useState([]); 
  const [complaint, setComplaint] = useState('');

  const fetchDoctors = async () => {
    try {
      const res = await api.get('/patient/doctors');
      setDoctors(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    const userData = JSON.parse(localStorage.getItem('user'));
    if (!userData || userData.role !== 'patient') {
      alert('Khusus Pasien!');
      router.push('/dashboard');
      return;
    }
    setUser(userData);
    fetchDoctors();
    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectDoctor = async (doctor) => {
    setSelectedDoctor(doctor);
    try {
      const res = await api.get(`/doctor/slots/${doctor.id}`);
      const availableSlots = res.data.filter(slot => slot.status === 'available');
      setSlots(availableSlots);
    } catch (err) {
      alert('Gagal ambil jadwal dokter');
    }
  };

  const handleBook = async (slotId) => {
    if (!complaint) return alert('Isi keluhan dulu ya!');
    
    if (!confirm('Yakin mau booking jam ini?')) return;

    try {
      const res = await api.post('/patient/book', {
        user_id: user.id,
        slot_id: slotId,
        complaint: complaint
      });

      const waNumber = res.data.doctor_wa.replace(/^0/, '62'); 
      const message = `Halo Dok ${res.data.doctor_name}, saya ${user.name} sudah booking jadwal di MindEase. Keluhan: ${complaint}. Mohon info pembayaran.`;
      
      const waLink = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;

      alert('Booking Berhasil! Anda akan dialihkan ke WhatsApp Dokter.');
      window.open(waLink, '_blank'); 
      
      router.push('/dashboard'); 

    } catch (err) {
      alert('Gagal: ' + (err.response?.data?.message || 'Error'));
    }
  };

  if (!user) return <p>Loading...</p>;

  return (
    <div>
      <button onClick={() => router.back()}>← Kembali</button>
      <h1>🔍 Cari Dokter & Booking</h1>

      {!selectedDoctor ? (
        <div>
          {doctors.map(doc => (
            <div key={doc.id}>
              <h3>Dr. {doc.name}</h3>
              <p>{doc.specialization}</p>
              <p>Biaya: Rp {doc.consultation_fee}</p>
              <button onClick={() => handleSelectDoctor(doc)}>
                Lihat Jadwal
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div>
            <h3>Jadwal Praktek: Dr. {selectedDoctor.name}</h3>
            <button onClick={() => setSelectedDoctor(null)}>Ganti Dokter</button>
          </div>

          <textarea 
            placeholder="Tulis keluhan singkat Anda di sini..." 
            value={complaint}
            onChange={(e) => setComplaint(e.target.value)}
          />

          <div>
            {slots.length === 0 ? <p>Dokter ini belum buka praktek.</p> : slots.map(slot => (
              <div key={slot.id}>
                <p><strong>{slot.date.split('T')[0]}</strong></p>
                <p>{slot.start_time.slice(0,5)} - {slot.end_time.slice(0,5)}</p>
                <button onClick={() => handleBook(slot.id)}>
                  Booking Sekarang
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}