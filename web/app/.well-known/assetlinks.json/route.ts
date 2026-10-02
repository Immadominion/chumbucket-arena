/**
 * GET /.well-known/assetlinks.json — Android App Links verification.
 * The certificate list and the owner action live in lib/assetLinks.ts.
 */

import { assetLinks } from "@/lib/assetLinks";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  return new Response(JSON.stringify(assetLinks(), null, 2), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}
