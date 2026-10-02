import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";
import { SessionProvider } from "@/lib/session";

export const metadata: Metadata = {
  // Absolute OG/Twitter URLs. Defaults to the live site so a deploy without
  // NEXT_PUBLIC_SITE_URL never advertises localhost in link previews.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://chumbucket.fun"),
  title: "Chumbucket: see what people call on real prediction markets",
  description:
    "Follow named people's calls on live Panta prediction markets. Back them, fade them, or challenge a friend, and keep a receipt nobody can edit.",
  icons: { icon: "/img/bucket.png" },
  openGraph: {
    siteName: "Chumbucket",
    title: "Chumbucket: see what people call on real prediction markets",
    description:
      "Follow named people's calls on live Panta prediction markets. Back them, fade them, or challenge a friend, and keep a receipt nobody can edit.",
    images: ["/img/logo-320.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#1a1013",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Warm every font origin in parallel before the render-blocking CSS
            requests them, the stylesheet host AND the woff2 file host each need
            their own connection (fonts are always fetched with CORS). */}
        {/* PP Neue Machina (display) is served locally from /public/fonts via
            @font-face in globals.css, matches the landing. Inter (body) + mono
            from Google. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <SessionProvider>{children}</SessionProvider>
        </Providers>
      </body>
    </html>
  );
}
