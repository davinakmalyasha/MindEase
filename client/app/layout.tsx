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
// and `scripts/fetch-fonts.js` to upgrade them. The font is a variable font, so
// one file covers every weight the UI uses and `weight` is omitted.
//
// Only Plus Jakarta is declared. Geist Sans and Geist Mono were also declared
// here, each registering a CSS variable that nothing applied - the body has only
// ever carried `jakarta`'s - so both were downloaded and served to every visitor
// and then never used. They were removed rather than applied, because wiring a
// font into a design is a decision and deleting an unused one is not.
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
    // `suppressHydrationWarning` belongs on <html>, not on <body>.
    //
    // `ThemeProvider` is next-themes with `attribute="class"`, and next-themes
    // runs a blocking inline script before hydration that writes `light` or
    // `dark` onto the <html> element (plus `color-scheme`) so the page does not
    // flash the wrong theme. The server cannot know which, because it cannot read
    // the stored preference. So the server renders `class="scroll-smooth"` and
    // the browser finds `class="scroll-smooth light"`.
    //
    // That is the mismatch React warns about on every page in development, and
    // it had `suppressHydrationWarning` on <body> instead, where it does
    // nothing - it only suppresses mismatches on the element it is written on,
    // and the mismatch is one level up.
    //
    // It was not cosmetic. On a hard hydration failure React discards the server
    // tree and rebuilds on the client, and on /login that happened before the
    // form's submit handler was attached. The form then fell back to a native
    // GET, which put the password into the URL - and into browser history, proxy
    // logs and any Referer header - on a page that looked like it had worked.
    <html lang={locale} className="scroll-smooth" suppressHydrationWarning>
      <body className={`${jakarta.className} ${jakarta.variable}`}>
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
