import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import ThemeProvider from "@/components/ui/ThemeProvider";
import IntlProvider from "@/components/ui/IntlProvider";
import InteractiveBlobs from "@/components/ui/InteractiveBlobs";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import SupportChat from "@/components/ui/SupportChat";
import CookieBanner from "@/components/ui/CookieBanner";
import PushPromptBanner from "@/components/ui/PushPromptBanner";
import ServiceWorkerRegistration from "@/components/ui/ServiceWorkerRegistration";
import SOSAlertModal from "@/components/ui/SOSAlertModal";
import { AuthProvider } from "@/context/AuthContext";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import QueryProvider from "@/components/ui/QueryProvider";
import enMessages from "../messages/en.json";
import idMessages from "../messages/id.json";
import "./globals.css";

// Self-hosted via `next/font/local`, not `next/font/google`.
//
// `next/font/google` downloads the font files at build time, which made the
// build depend on reaching `fonts.googleapis.com`. That failed twice on a
// transient network error - once in CI and once locally - and the error was
// `Failed to fetch Geist from Google Fonts` / `Can't resolve
// '@vercel/turbopack-next/internal/font/google/font'`, which reads like a broken
// dependency rather than a flaky network and sent me looking in the wrong place
// both times. A build that fails on someone else's connection is not a build.
//
// The files are committed under `app/fonts/` (SIL OFL 1.1); see the README there
// and `scripts/fetch-fonts.js` to upgrade them. All three are variable fonts, so
// one file each covers every weight the UI uses and `weight` is omitted.
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  display: "swap",
});

const jakarta = localFont({
  src: "./fonts/PlusJakartaSans-Variable.woff2",
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://mindease.app"),
  title: {
    default: "MindEase - Mental Health Consultation Platform",
    template: "%s | MindEase",
  },
  description: "Connect with certified psychologists, track your mood, and prepare for sessions with AI-powered insights. Mental health care that fits your life.",
  keywords: ["mental health", "psychologist", "consultation", "therapy", "mood tracker", "MindEase"],
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    apple: "/icon-192.png",
  },
  openGraph: {
    title: "MindEase",
    description: "Premium mental health consultation platform with AI-powered support.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "MindEase — Mental health care that fits your life" }],
  },
  robots: { index: true, follow: true },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
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
                <ConfirmProvider>
                  <QueryProvider>
                    <InteractiveBlobs />
                    <ServiceWorkerRegistration />
                    <ErrorBoundary>{children}</ErrorBoundary>
                    {/* Mounted at the root, not inside the dashboard layout: a
                        clinician reading /messages when a patient presses SOS
                        is exactly the person who needs to see it. */}
                    <SOSAlertModal />
                    <SupportChat />
                    <CookieBanner />
                    <PushPromptBanner />
                  </QueryProvider>
                </ConfirmProvider>
              </ToastProvider>
            </AuthProvider>
          </ThemeProvider>
        </IntlProvider>
      </body>
    </html>
  );
}
