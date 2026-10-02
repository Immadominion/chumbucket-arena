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
