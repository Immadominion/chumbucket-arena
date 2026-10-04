import type { NextConfig } from "next";
import { dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

// Privy lazily references optional login connectors (Farcaster mini-app, Stripe
// fiat on-ramp, …) that aren't installed. Point them at an empty stub so neither
// webpack (build) nor Turbopack (dev) wastes time resolving / warning on them.
const OPTIONAL_DEPS = ["@farcaster/mini-app-solana", "@stripe/crypto"];

// Files the link-preview images (lib/ogCard.tsx) read at request time. Public
// assets are not part of a serverless function unless traced, so every
// opengraph-image route lists them explicitly.
const OG_ASSET_FILES = [
  "./public/fonts/PPNeueMachina-Regular.otf",
  "./public/fonts/PPNeueMachina-Ultrabold.otf",
  "./public/img/logo-192.png",
];

const nextConfig: NextConfig = {
  // This app lives in a monorepo (the Bun backend is the repo root). Pin the
  // file-tracing root to web/ so Next doesn't pick up the parent lockfile.
  outputFileTracingRoot: here,
  outputFileTracingIncludes: {
    "/**/opengraph-image": OG_ASSET_FILES,
  },
  // External avatar/flag images are used directly via <img>, so no next/image
  // remote config is required. GLB models are served from /public/models.
  eslint: { ignoreDuringBuilds: true },
  // Barrel packages (icons, Privy) otherwise pull thousands of modules into every
  // page's compile. This rewrites them to direct imports → seconds, not minutes.
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react", "@privy-io/react-auth"],
  },
  // The retired football-and-escrow Arena: its pages are gone, and anyone
  // holding an old link lands in the web app instead (/app). Temporary
  // redirects, so a browser does not remember them forever. Legacy challenge
  // links (/c/chg_…) still render, through the rewrite below.
  async redirects() {
    const toApp = (source: string, destination = "/app") => ({ source, destination, permanent: false });
    return [
      toApp("/signin"),
      toApp("/arena"),
      toApp("/matchday"),
      toApp("/predictions"),
      toApp("/results"),
      toApp("/send"),
      toApp("/bet"),
      toApp("/bet/:matchId"),
      toApp("/challenge/:matchId"),
      toApp("/caller/:wallet"),
      toApp("/friends", "/app/friends"),
      toApp("/settings", "/app/me"),
      toApp("/wallet", "/app/me"),
    ];
  },
  // Legacy Arena challenge links (/c/chg_…) render from their own route, so the
  // /c share page every new call link opens never ships the Arena client.
  async rewrites() {
    return {
      beforeFiles: [{ source: "/c/:challengeId(chg_[^/]+)", destination: "/legacy-challenge/:challengeId" }],
      afterFiles: [],
      fallback: [],
    };
  },
  turbopack: {
    resolveAlias: Object.fromEntries(OPTIONAL_DEPS.map((d) => [d, "./lib/empty-module.ts"])),
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(OPTIONAL_DEPS.map((d) => [d, false])),
    };
    return config;
  },
};

export default nextConfig;
