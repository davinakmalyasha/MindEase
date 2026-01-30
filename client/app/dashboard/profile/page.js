"use client";

import { useState, useEffect } from "react";
import api from "../../../utils/api";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [bio, setBio] = useState("");
  const [specialization, setSpecialization] = useState("");
  const [fee, setFee] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await api.get("/users/profile");
        const data = res.data;
        setUser(data);

        setName(data.name);
        setPhone(data.phone_number);
        setPreview(data.avatar);

        if (data.role === "doctor") {
          setBio(data.bio || "");
          setSpecialization(data.specialization || "");
          setFee(data.consultation_fee || "");
        }
      } catch (err) {
        alert("Gagal ambil data profile");
      }
    };

    fetchProfile();
  }, []);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    setFile(selectedFile);
    if (selectedFile) {
      setPreview(URL.createObjectURL(selectedFile));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const formData = new FormData();
    formData.append("name", name);
    formData.append("phone_number", phone);
    if (file) formData.append("avatar", file);

    if (user.role === "doctor") {
      formData.append("bio", bio);
      formData.append("specialization", specialization);
      formData.append("consultation_fee", fee);
    }

    try {
      const res = await api.put("/users/profile", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });

      alert("Profile Berhasil Diupdate!");

      const updatedUser = {
        ...JSON.parse(localStorage.getItem("user")),
        ...res.data.user,
      };
      localStorage.setItem("user", JSON.stringify(updatedUser));

      window.location.reload();
    } catch (err) {
      console.error(err);
      alert("Gagal update: " + (err.response?.data?.message || "Error"));
    }
  };

  if (!user) return <p>Loading...</p>;

  return (
    <div>
      <button onClick={() => router.back()}>← Kembali</button>
      <h1>Edit Profile</h1>

      <div>
        <img
          src={
            preview && preview !== "default.jpg"
              ? preview
              : "https://via.placeholder.com/150"
          }
          alt="Avatar"
        />
      </div>

      <form onSubmit={handleSubmit}>
        <label>Ganti Foto Profil:</label>
        <input type="file" onChange={handleFileChange} accept="image/*" />

        <label>Nama Lengkap:</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <label>No WhatsApp:</label>
        <input
          type="text"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />

        {user.role === "doctor" && (
          <div>
            <h3>Detail Dokter</h3>

            <label>Spesialisasi:</label>
            <input
              type="text"
              value={specialization}
              onChange={(e) => setSpecialization(e.target.value)}
            />

            <label>Biaya Konsultasi:</label>
            <input
              type="number"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />

            <label>Bio Singkat:</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows="3"
            />
          </div>
        )}

        <button type="submit">Simpan Perubahan</button>
      </form>
    </div>
  );
}
