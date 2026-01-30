"use client";

import { useState, useEffect } from 'react';
import api from '../../../utils/api';
import { useRouter } from 'next/navigation';

export default function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]); 
  const [loading, setLoading] = useState(true);

  const fetchAdminData = async () => {
    try {
      const resStats = await api.get('/admin/stats');
      setStats(resStats.data);

      const resUsers = await api.get('/admin/users');
      setUsers(resUsers.data);
      
      setLoading(false);
    } catch (err) {
      console.error(err);
      alert('Gagal ambil data admin. Pastikan server nyala & token valid.');
    }
  };

  useEffect(() => {
    const userData = JSON.parse(localStorage.getItem('user'));
    
    if (!userData || userData.role !== 'admin') {
      alert('Hush! Anda bukan Admin!');
      router.push('/dashboard');
      return;
    }
    fetchAdminData();
    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  if (loading) return <p>Loading Data Rahasia...</p>;

  return (
    <div>
      <button onClick={() => router.back()}>← Kembali</button>
      
      <h1>👮‍♂️ Admin Dashboard</h1>
      <p>Monitoring Statistik Harian MindEase</p>
      <div>
        <div>
          <h3>👥 Total Pasien</h3>
          <h1>{stats.total_patients}</h1>
        </div>
        <div>
          <h3>👨‍⚕️ Total Dokter</h3>
          <h1>{stats.total_doctors}</h1>
        </div>

        <div>
          <h3>✅ Konsultasi Sukses</h3>
          <h1>{stats.successful_bookings}</h1>
        </div>

        <div>
          <h3>💰 Estimasi Omzet</h3>
          <h1>
            Rp {parseInt(stats.total_estimated_revenue).toLocaleString('id-ID')}
          </h1>
        </div>
      </div>

      <h3>Daftar Pengguna Sistem</h3>
      <table border="1" cellPadding="10">
        <thead>
          <tr>
            <th>ID</th>
            <th>Nama</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <span>
                    {u.role.toUpperCase()}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}