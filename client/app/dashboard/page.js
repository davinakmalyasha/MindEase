"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    const userData = localStorage.getItem("user");

    if (!token) {
      alert("Eits, login dulu dong!");
      router.push("/login");
    } else {
      if (userData) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUser(JSON.parse(userData));
      }
    }
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    alert("Anda berhasil logout.");
    router.push("/login");
  };

  if (!user) return <p>Loading Dashboard...</p>;

  return (
    <div>
      <h1>Dashboard MindEase</h1>

      <div>
        <img
          src={
            user.avatar && user.avatar !== "default.jpg"
              ? user.avatar
              : "https://via.placeholder.com/150"
          }
          alt="Profile"
        />
        <div>
          <h2>
            Halo, {user.role === "doctor" ? "Dr. " : ""}
            {user.name}! 👋
          </h2>
          <p>
            Role: <strong>{user.role}</strong> | {user.email}
          </p>
          <button onClick={() => router.push("/dashboard/profile")}>
            ✏️ Edit Profile
          </button>
        </div>
      </div>

      <br />

      {user.role === "doctor" && (
        <div>
          <h3>👨‍⚕️ Menu Dokter</h3>
          <ul>
            <li>
              <button onClick={() => router.push("/dashboard/doctor/schedule")}>
                📅 Atur Jadwal Konsultasi
              </button>
            </li>
            <li>
              <button onClick={() => router.push("/dashboard/appointments")}>
                📝 Lihat Riwayat Pasien
              </button>
            </li>
          </ul>
        </div>
      )}

      {user.role === "patient" && (
        <div>
          <h3>🙂 Menu Pasien</h3>
          <ul>
            <li>
              <button onClick={() => router.push("/dashboard/patient/booking")}>
                🔍 Cari Dokter & Booking
              </button>
            </li>
            <li>
              <button onClick={() => router.push("/dashboard/appointments")}>
                📜 Riwayat Konsultasi Saya
              </button>
            </li>
          </ul>
        </div>
      )}

      {user.role === "admin" && (
        <div>
          <h3>👮‍♂️ Menu Admin (God Mode)</h3>
          <ul>
            <li>
              <button onClick={() => router.push("/dashboard/admin")}>
                📊 Lihat Statistik & User
              </button>
            </li>
          </ul>
        </div>
      )}

      <button onClick={handleLogout}>Logout</button>
    </div>
  );
}
