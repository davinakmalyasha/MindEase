import { Geist, Geist_Mono } from "next/font/google";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jakarta = Plus_Jakarta_Sans({ 
  subsets: ["latin"],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-jakarta', 
});

export const metadata = {
  title: "MindEase",
  description: "Aplikasi Konsultasi Kesehatan Mental",
};

export default function RootLayout({ children }) {
  return (
   <html lang="id">
      <body className={`${jakarta.className} ${jakarta.variable}`}>
        {children}
      </body>
    </html>
  );
}
