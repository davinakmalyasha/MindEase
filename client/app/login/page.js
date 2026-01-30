"use client";

import { useState } from "react";
import api from "../../utils/api";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "" });

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api.post("/auth/login", form);
      localStorage.setItem("token", res.data.token);
      localStorage.setItem("user", JSON.stringify(res.data.user));

      alert("Login Sukses! Selamat datang, " + res.data.user.name);

      router.push("/dashboard");
    } catch (error) {
      alert(
        "Login Gagal: " +
          (error.response?.data?.message || "Cek email/password"),
      );
    }
  };

  return (
    <div style={{ padding: "50px" }}>
      <h1>Login MindEase</h1>

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
          type="email"
          name="email"
          placeholder="Masukkan Email"
          onChange={handleChange}
          required
        />

        <input
          type="password"
          name="password"
          placeholder="Masukkan Password"
          onChange={handleChange}
          required
        />

        <button type="submit">Masuk</button>
      </form>

      <br />
      <a href="/register">Belum punya akun? Daftar</a>
    </div>
  );
}
