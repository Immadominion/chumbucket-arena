/**
 * Digital Asset Links for Android App Links on chumbucket.fun.
 *
 * Android fetches https://chumbucket.fun/.well-known/assetlinks.json (and the
 * www host) when the app is installed, and opens /c, /u and /m links straight
 * in the app only if the signing certificate of the installed APK is listed
 * here. A wrong or missing fingerprint never breaks anything: links simply
 * open this website, which has its own open-in-app button.
 *
 * ┌─ OWNER ACTION ──────────────────────────────────────────────────────────┐
 * │ RELEASE_CERT_SHA256 below is the certificate the Solana dApp Store      │
 * │ already pins for dev.cleva.chumbucket (publishing/config.yaml in the    │
 * │ mobile repo, cert_fingerprint 315b22c7…e1c7). Confirm it against the    │
 * │ restored upload key before release:                                     │
 * │   keytool -list -v -keystore upload-keystore.jks -alias <alias>         │
 * │ If the release is signed by any other key (or Google Play App Signing   │
 * │ re-signs it), add that SHA-256 via ANDROID_CERT_SHA256 on Vercel        │
 * │ (comma-separated, colon form) — no code change needed.                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

export const ANDROID_PACKAGE = "dev.cleva.chumbucket";

/** SHA-256 of the dApp Store-pinned release certificate (unconfirmed: see above). */
export const RELEASE_CERT_SHA256 =
  "31:5B:22:C7:FE:1C:28:5E:AE:7A:99:15:62:90:37:FC:8E:C3:23:9F:ED:34:7A:73:49:57:DC:25:08:50:E1:C7";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Normalises "aa:bb…" or "aabb…" to upper-case colon form; null if not a SHA-256. */
export function normaliseFingerprint(raw: string): string | null {
  const hex = raw.trim().replace(/:/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  const colon = hex.match(/.{2}/g)!.join(":");
  return FINGERPRINT.test(colon) ? colon : null;
}

export function assetLinks(extra: string | undefined = process.env.ANDROID_CERT_SHA256) {
  const fingerprints = new Set<string>([RELEASE_CERT_SHA256]);
  for (const part of (extra ?? "").split(",")) {
    const f = normaliseFingerprint(part);
    if (f) fingerprints.add(f);
  }
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ];
}
