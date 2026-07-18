import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";
import { SessionProvider } from "@/lib/session";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://thegaffer.fun"),
  title: "Chumbucket - social predictions settled by TxLINE",
  description:
    "Follow trusted callers, copy a football prediction, or challenge a friend. Chumbucket settles the result from TxLINE proofs on Solana.",
  icons: { icon: "/img/logo.png" },
  openGraph: {
    title: "Chumbucket - social predictions settled by TxLINE",
    description:
      "Follow a call, challenge a friend, and let a TxLINE proof settle the result on Solana.",
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
            requests them — the stylesheet host AND the woff2 file host each need
            their own connection (fonts are always fetched with CORS). */}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=satoshi@400,500,700,900&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&display=swap"
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
