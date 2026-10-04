import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { machina } from "@/components/site/fonts";
import { montserrat } from "@/components/webapp/fonts";
import { WebAppRoot } from "@/components/webapp/WebAppRoot";
import "@/components/webapp/app.css";

/**
 * /app: the signed-in web app (the calls product, as on the Android app).
 * Everything under it is per account, so nothing here is indexed and every
 * page renders in the browser. Shared links keep opening the public pages
 * (/c, /u, /m), which work without an account.
 */
export const metadata: Metadata = {
  title: { default: "Chumbucket", template: "%s · Chumbucket" },
  description: "See what people call on real Panta prediction markets. Back them, fade them, or make your own call.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#f4f4f4",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function WebAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WebAppRoot className={`${machina.variable} ${montserrat.variable}`}>
      <Suspense>{children}</Suspense>
    </WebAppRoot>
  );
}
