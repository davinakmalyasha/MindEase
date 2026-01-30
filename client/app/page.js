import Link from "next/link";

export default function Home() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ fontSize: "3rem", marginBottom: "10px" }}>MindEase 🌿</h1>
      <p style={{ fontSize: "1.2rem", color: "#666", marginBottom: "30px" }}>
        Platform Konsultasi Kesehatan Mental Terpercaya
      </p>

      <div style={{ display: "flex", gap: "20px" }}>
        <Link href="/login">
          <button
            style={{
              padding: "15px 30px",
              fontSize: "1rem",
              cursor: "pointer",
              backgroundColor: "#0070f3",
              color: "white",
              border: "none",
              borderRadius: "5px",
            }}
          >
            Masuk (Login)
          </button>
        </Link>

        <Link href="/register">
          <button
            style={{
              padding: "15px 30px",
              fontSize: "1rem",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: "#0070f3",
              border: "2px solid #0070f3",
              borderRadius: "5px",
            }}
          >
            Daftar Akun
          </button>
        </Link>
      </div>

      <div
        style={{
          marginTop: "50px",
          padding: "20px",
          backgroundColor: "#f0f0f0",
          borderRadius: "10px",
        }}
      >
        <h3>Cara Kerja:</h3>
        <ol style={{ textAlign: "left" }}>
          <li>Daftar sebagai Pasien atau Dokter.</li>
          <li>Login ke Dashboard.</li>
          <li>Dokter buka jadwal, Pasien booking jadwal.</li>
          <li>Konsultasi via WhatsApp!</li>
        </ol>
      </div>
    </div>
  );
}
