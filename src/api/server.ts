/**
 * HTTP + WebSocket transport for the tRPC router. Queries/mutations go over HTTP;
 * subscriptions over WS on the same port. CORS is wide open so the frontend (and
 * the public Dossier pages) can call from anywhere during the hackathon.
 *
 * Auth is a wallet identifier: header `x-wallet` for HTTP, connectionParams for
 * WS. (A production build verifies a Privy session; the seam is the same.)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import type { App } from "../app.ts";
import { handleHeliusWebhook } from "../indexer/HeliusWebhook.ts";
import type { AnyRouter } from "@trpc/server";
import { servedRouter } from "./router.ts";
import { makeContext } from "./trpc.ts";

/** Credential from the request: `Authorization: Bearer <privy token>`, or the
 *  `x-wallet` header in dev mode. */
const tokenFrom = (req: IncomingMessage | undefined): string | undefined => {
  const auth = req?.headers?.["authorization"];
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (a && a.startsWith("Bearer ")) return a.slice(7);
  const w = req?.headers?.["x-wallet"];
  return Array.isArray(w) ? w[0] : w;
};

/** Social clients use the standard bearer header. The separate header remains
 * available for a request proving BOTH a legacy and a Supabase session.
 * This merely transports the token; GoTrue must verify it before use. */
const supabaseTokenFrom = (req: IncomingMessage | undefined): string | undefined => {
  const h = req?.headers?.["x-supabase-authorization"] ?? req?.headers?.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return undefined;
  return v.startsWith("Bearer ") ? v.slice(7) : v;
};

/**
 * The caller's address, for per-IP write limits only — never for anything
 * that decides who someone is.
 *
 * Railway's edge strips any X-Forwarded-For a client sends and writes its
 * own, with the real connecting address FIRST; X-Real-IP, by contrast, holds
 * the CDN's address whenever the CDN path is active, which would put every
 * person in one bucket. So the default is the first X-Forwarded-For entry.
 * Behind a proxy that appends instead, set CLIENT_IP_SOURCE=xff-last.
 */
export function clientIpFrom(
  req: IncomingMessage | undefined,
  source: string | undefined = process.env.CLIENT_IP_SOURCE,
): string | undefined {
  const header = (name: string): string | undefined => {
    const v = req?.headers?.[name];
    return (Array.isArray(v) ? v.join(",") : v)?.trim() || undefined;
  };
  const hops = (header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const socket = req?.socket?.remoteAddress ?? undefined;
  switch (source) {
    case "socket":
      return socket;
    case "x-real-ip":
      return header("x-real-ip") ?? socket;
    case "xff-last":
      return hops[hops.length - 1] ?? socket;
    default:
      return hops[0] ?? socket;
  }
}

export interface StartServerOptions {
  /** Default: `servedRouter()` — the calls BFF surface unless LEGACY_ARENA_ROUTES=true. */
  router?: AnyRouter;
}

export function startServer(app: App, port: number, host?: string, options: StartServerOptions = {}) {
  const router = options.router ?? servedRouter();
  const http = createHTTPServer({
    router,
    createContext: (opts) =>
      makeContext(app, tokenFrom(opts.req), supabaseTokenFrom(opts.req), clientIpFrom(opts.req)),
    middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/webhooks/helius") {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          return;
        }
        handleHeliusWebhook(app, req, res).catch((e) => {
          console.error("[helius-webhook]", e);
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "webhook failed" }));
        });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Expose-Headers", "*");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      next();
    },
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        console.error(`[trpc] ${path ?? "?"}:`, error.message);
      }
    },
  });

  const wss = new WebSocketServer({ server: http });
  const wsHandler = applyWSSHandler({
    wss,
    router,
    createContext: (opts) =>
      makeContext(
        app,
        (opts.info?.connectionParams?.token as string | undefined) ??
          (opts.info?.connectionParams?.wallet as string | undefined) ??
          tokenFrom(opts.req),
        (opts.info?.connectionParams?.supabaseAccessToken as string | undefined) ??
          supabaseTokenFrom(opts.req),
        clientIpFrom(opts.req),
      ),
  });

  http.on("close", () => wsHandler.broadcastReconnectNotification());
  // Local integration rigs bind loopback explicitly; deployed callers retain
  // the existing default host when they omit this optional argument.
  http.listen(port, host);
  return { http, wss, wsHandler };
}
