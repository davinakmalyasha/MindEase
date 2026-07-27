import { Geist, Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { cookies } from "next/headers";
import ThemeProvider from "@/components/ui/ThemeProvider";
import IntlProvider from "@/components/ui/IntlProvider";
import InteractiveBlobs from "@/components/ui/InteractiveBlobs";
import { AuthProvider } from "@/context/AuthContext";
import { ToastProvider } from "@/components/ui/Toast";
import QueryProvider from "@/components/ui/QueryProvider";
import enMessages from "../messages/en.json";
import idMessages from "../messages/id.json";
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
  title: {
    default: "MindEase - Mental Health Consultation Platform",
    template: "%s | MindEase",
  },
  description: "Connect with certified psychologists, track your mood, and prepare for sessions with AI-powered insights. Mental health care that fits your life.",
  keywords: ["mental health", "psychologist", "consultation", "therapy", "mood tracker", "MindEase"],
  openGraph: {
    title: "MindEase",
    description: "Premium mental health consultation platform with AI-powered support.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default async function RootLayout({ children }) {
  const cookieStore = await cookies();
  const locale = cookieStore.get("locale")?.value === "id" ? "id" : "en";
  const messages = locale === "id" ? idMessages : enMessages;

  return (
    <html lang={locale} className="scroll-smooth">
      <body className={`${jakarta.className} ${jakarta.variable}`} suppressHydrationWarning>
        <IntlProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <AuthProvider>
              <ToastProvider>
                <QueryProvider>
                  <InteractiveBlobs />
                  {children}
                </QueryProvider>
              </ToastProvider>
            </AuthProvider>
          </ThemeProvider>
        </IntlProvider>
      </body>
    </html>
  );
}
