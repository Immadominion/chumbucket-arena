/**
 * HTTP + WebSocket transport for the tRPC router. Queries/mutations go over HTTP;
 * subscriptions over WS on the same port. CORS is wide open so the frontend (and
 * the public Dossier pages) can call from anywhere during the hackathon.
 *
 * Auth is a wallet identifier: header `x-wallet` for HTTP, connectionParams for
 * WS. (A production build verifies a Privy session; the seam is the same.)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app";
export declare function startServer(app: App, port: number): {
    http: import("node:http").Server<typeof IncomingMessage, typeof ServerResponse>;
    wss: import("ws").Server<typeof import("ws").default, typeof IncomingMessage>;
    wsHandler: {
        broadcastReconnectNotification: () => void;
    };
};
