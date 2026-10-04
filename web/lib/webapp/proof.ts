/**
 * The proof window's answer, for one attempt only. Pure (BroadcastChannel is
 * a browser global), so the BFF repo's bun tests can drive it.
 *
 * An X/Google proof runs PKCE in a separate window: the window returns to
 * /app/link with this attempt's nonce and Supabase's one-time code, and posts
 * {n, code} here. Anything else on the channel is ignored — no nonce, another
 * attempt's nonce, a token instead of a code, junk — and a code that did
 * arrive is still useless without the verifier in the asking page's memory.
 */

import { LINK_CHANNEL } from "./linking";

/** Where a link stopped: a BFF/Supabase code, "cancelled", "popup" or "network". */
export class LinkStopped extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LinkStopped";
  }
}

/**
 * The code the proof window hands back for THIS attempt. Anything else on the
 * channel — no nonce, another nonce, a token instead of a code — is ignored.
 * Exported for tests.
 */
export function awaitProofCode(
  nonce: string,
  popup: { close(): void } | null,
  signal: AbortSignal,
  channelName: string = LINK_CHANNEL,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel(channelName);
    const timer = setTimeout(() => done(new LinkStopped("cancelled")), 5 * 60_000);
    const onAbort = () => {
      try {
        popup?.close();
      } catch {
        // Already gone.
      }
      done(new LinkStopped("cancelled"));
    };
    function done(result: string | LinkStopped) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      channel.close();
      if (typeof result === "string") resolve(result);
      else reject(result);
    }
    signal.addEventListener("abort", onAbort);
    channel.onmessage = (event: { data: unknown }) => {
      const d = event.data as { n?: unknown; code?: unknown; error?: unknown } | null;
      if (!d || typeof d.n !== "string" || d.n !== nonce) return; // not this attempt
      if (typeof d.code === "string" && /^[A-Za-z0-9-]{8,128}$/.test(d.code)) done(d.code);
      else if (typeof d.error === "string" && d.error) done(new LinkStopped(d.error));
    };
  });
}

