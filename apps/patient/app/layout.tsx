import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const DESCRIPTION = "Clinical trial pre-screening in your browser: trial sites send their criteria to you, and your record is not sent to them.";
const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "ChartStays — Your record stays. The trials come to you." };

export const metadata: Metadata = {
  metadataBase: new URL("https://chartstays.pages.dev"),
  title: "ChartStays",
  description: DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  openGraph: {
    type: "website",
    siteName: "ChartStays",
    title: "ChartStays",
    description: DESCRIPTION,
    url: "/",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "ChartStays",
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <header className="site-header">
          <div className="site-header-inner">
            <a className="brand" href="/">
              {/* Decorative: the wordmark text next to it names the link. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="brand-mark" src="/logo.svg" width="32" height="32" alt="" />
              ChartStays
            </a>
            <nav aria-label="Main">
              <ul className="site-nav">
                <li>
                  <a href="/#how-it-works">How it works</a>
                </li>
                <li>
                  <a href="/#privacy">Privacy</a>
                </li>
                <li>
                  <a className="nav-cta" href="/match">
                    Find trials
                  </a>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="site-footer-inner">
            <p className="footer-brand">ChartStays</p>
            <p className="muted">
              Study data: ClinicalTrials.gov, criteria structured by ChartStays. Demo patients are synthetic (Synthea); no real person&apos;s data is used.
            </p>
            <p className="muted">ChartStays is not a medical device and cannot enroll anyone in a study.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
