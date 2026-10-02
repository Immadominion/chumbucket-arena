/**
 * The deletion page's form posts here (plain HTML, no client JavaScript).
 * It forwards to the calls BFF's `trust.requestDeletion`, which stores the
 * request and rate-limits per contact, then sends the person back to the page
 * with a status. Nothing is deleted from here: the request is verified first.
 */

import { NextResponse } from "next/server";

const BFF_URL = (process.env.CALLS_BFF_URL ?? "https://chumbucket-calls-bff-production.up.railway.app").replace(/\/+$/, "");

function back(req: Request, status: string): NextResponse {
  return NextResponse.redirect(new URL(`/delete-account?status=${status}#request`, req.url), 303);
}

const text = (v: FormDataEntryValue | null, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return back(req, "unavailable");
  }
  // Honeypot: people never see this field. Answer as if it worked.
  if (text(form.get("website"), 200)) return back(req, "sent");

  const contact = text(form.get("contact"), 254);
  if (!contact || contact.length < 3) return back(req, "contact");

  try {
    const res = await fetch(`${BFF_URL}/trust.requestDeletion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // tRPC + superjson input envelope.
      body: JSON.stringify({
        json: {
          contact,
          handle: text(form.get("handle"), 40),
          walletAddress: text(form.get("wallet"), 64),
          details: text(form.get("details"), 1000),
        },
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (res.ok) return back(req, "sent");
    if (res.status === 429) return back(req, "rate");
    if (res.status === 400) return back(req, "contact");
    return back(req, "unavailable");
  } catch {
    return back(req, "unavailable");
  }
}
