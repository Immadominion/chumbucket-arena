/**
 * Regenerate the vendored backend type declarations the frontend consumes.
 *
 * The frontend (`web/`) is a standalone repo (deployed to Vercel) and imports
 * `AppRouter` from `web/server-types/` via its `@server` alias — so it stays
 * end-to-end typed without depending on this repo at build time. Run this from
 * the repo root whenever the API surface changes, then commit `web/server-types`
 * in the frontend repo:
 *
 *   bun run gen:types
 */
import { $ } from "bun";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "web/server-types";

rmSync(OUT, { recursive: true, force: true });
// allowImportingTsExtensions in tsconfig forces emitDeclarationOnly (no JS).
await $`tsc -p tsconfig.json --declaration --emitDeclarationOnly --noEmit false --outDir ${OUT}`.nothrow();
rmSync(join(OUT, "scripts"), { recursive: true, force: true });
rmSync(join(OUT, "tests"), { recursive: true, force: true });

// Strip `.ts` extensions from emitted import specifiers so they resolve to the
// sibling `.d.ts` files (the frontend has no `.ts` sources for them).
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".d.ts") ? [p] : [];
  });
}
let n = 0;
for (const f of walk(OUT)) {
  const fixed = readFileSync(f, "utf8").replace(/(from\s+"[^"]+|import\("[^"]+)\.ts"/g, '$1"');
  writeFileSync(f, fixed);
  n++;
}
console.log(`Regenerated ${OUT} (${n} .d.ts) from src/api/router.ts → commit it in the frontend repo.`);
