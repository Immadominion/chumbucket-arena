import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";
import { SessionProvider } from "@/lib/session";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "ChumBucket - predict football with friends, settled by TxLINE",
  description:
    "Predict a football match, challenge a friend, and let the real score settle it on Solana via TxLINE.",
  icons: { icon: "/img/bucket.png" },
  openGraph: {
    title: "ChumBucket - predict football with friends, settled by TxLINE",
    description:
      "Predict a football match, challenge a friend, and let the real score settle it on Solana via TxLINE.",
    images: ["/img/logo.png"],
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
