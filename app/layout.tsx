import type { Metadata, Viewport } from "next";
import "./globals.css";

const productionHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ||
  "own-link-checker-clean.vercel.app";
const siteUrl = `https://${productionHost}`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "LinkPulse — премиальная проверка ссылок",
  description:
    "Потоковая проверка доступности, редиректов и скорости сотен URL с понятной диагностикой и экспортом.",
  applicationName: "LinkPulse",
  openGraph: {
    title: "LinkPulse — премиальная проверка ссылок",
    description:
      "Проверяйте доступность, редиректы и скорость сотен URL в одном потоке.",
    type: "website",
    locale: "ru_RU",
    url: "/",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#070b0c" },
    { media: "(prefers-color-scheme: light)", color: "#edf1ef" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
