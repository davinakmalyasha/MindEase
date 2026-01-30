"use client";

import { useState } from "react";
import api from "../../utils/api";
import { useRouter } from "next/navigation";

export default function Register() {
  const router = useRouter();

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone_number: "",
    role: "patient",
  });

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post("/auth/register", form);
      alert("Register Berhasil! Otw Login...");
      router.push("/login");
    } catch (error) {
      alert("Gagal: " + (error.response?.data?.message || "Server Error"));
    }
  };

  return (
    <div style={{ padding: "50px" }}>
      <h1>Register MindEase</h1>

      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          maxWidth: "300px",
        }}
      >
        <input
          type="text"
          name="name"
          placeholder="Nama Lengkap"
          onChange={handleChange}
          required
        />

        <input
          type="email"
          name="email"
          placeholder="Email"
          onChange={handleChange}
          required
        />

        <input
          type="number"
          name="phone_number"
          placeholder="No. WhatsApp (08xxx)"
          onChange={handleChange}
          required
        />

        <input
          type="password"
          name="password"
          placeholder="Password"
          onChange={handleChange}
          required
        />

        <select name="role" onChange={handleChange}>
          <option value="patient">Pasien</option>
          <option value="doctor">Dokter</option>
        </select>

        <button type="submit">Daftar Sekarang</button>
      </form>

      <br />
      <a href="/login">Sudah punya akun? Login</a>
    </div>
  );
}
