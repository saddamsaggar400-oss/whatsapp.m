import type { Metadata } from "next";
import "./globals.css";
import "../components/messenger.css";
export const metadata: Metadata = {
  title: "التحدث عبر الواتس اب",
  openGraph: { title: "التحدث عبر الواتس اب", description: "محادثة مباشرة مع صاحب الحساب." },
  description: "محادثة خاصة بينك وبين صاحب الموقع على وصال.",
  icons: { icon: "/favicon.svg" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "وصال", statusBarStyle: "default" },
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
