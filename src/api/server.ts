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
import { appRouter } from "./router.ts";
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

export function startServer(app: App, port: number) {
  const http = createHTTPServer({
    router: appRouter,
    createContext: (opts) => makeContext(app, tokenFrom(opts.req)),
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
    router: appRouter,
    createContext: (opts) =>
      makeContext(
        app,
        (opts.info?.connectionParams?.token as string | undefined) ??
          (opts.info?.connectionParams?.wallet as string | undefined) ??
          tokenFrom(opts.req),
      ),
  });

  http.on("close", () => wsHandler.broadcastReconnectNotification());
  http.listen(port);
  return { http, wss, wsHandler };
}
