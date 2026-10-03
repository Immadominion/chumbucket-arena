import type { Metadata, Viewport } from "next";
import "./globals.css";

// The default for every page without its own (the landing page sets the same).
// Never "bet", "challenge a friend" or "win": see web/docs/positioning.md.
const TITLE = "Chumbucket: FOMO for prediction markets";
const DESCRIPTION =
  "See what people call on real Panta prediction markets and how often they’re right. Back them, fade them or dare a friend, and keep a receipt nobody can edit.";

export const metadata: Metadata = {
  // Absolute OG/Twitter URLs. Defaults to the live site so a deploy without
  // NEXT_PUBLIC_SITE_URL never advertises localhost in link previews.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://chumbucket.fun"),
  title: TITLE,
  description: DESCRIPTION,
  // Small square crops of /img/bucket.png (2.3 MB, too heavy for a tab icon).
  icons: {
    icon: [{ url: "/img/bucket-64.png", sizes: "64x64", type: "image/png" }],
    apple: [{ url: "/img/bucket-180.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    siteName: "Chumbucket",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/img/logo-320.png"],
  },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
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
      {/* Client providers (Privy, React Query, tRPC, session) and the Arena's
          Google fonts (components/ArenaFonts.tsx) are mounted by the routes
          that use them: see components/AppProviders.tsx. The public site
          loads only its own woff2 through next/font. */}
      <body>{children}</body>
    </html>
  );
}
