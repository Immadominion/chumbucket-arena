import localFont from "next/font/local";

/**
 * Montserrat, the app's body face (the Android app ships the same two cuts,
 * OFL: app/fonts/Montserrat-OFL.txt). Bold text is set in PP Neue Machina,
 * as on the phone. Exposed as --font-montserrat on the web app's root.
 */
export const montserrat = localFont({
  src: [
    { path: "../../app/fonts/Montserrat-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../app/fonts/Montserrat-Medium.woff2", weight: "500 700", style: "normal" },
  ],
  variable: "--font-montserrat",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});
