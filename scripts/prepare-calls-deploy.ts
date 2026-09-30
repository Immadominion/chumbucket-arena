/** Secret-free committed-source export plus local import-graph validation.
 * bun --no-env-file scripts/prepare-calls-deploy.ts --prepare
 * Does not deploy, load env files, start the app or contact a provider.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.length !== 3 || process.argv[2] !== "--prepare") {
  throw new Error("Explicit --prepare required; this command does not deploy");
}
process.umask(0o077);
const root = resolve(import.meta.dir, "..");
// Vendor IDLs are required by the shared existing server even when its old
// trading routes are disabled. Omitting them crashes before the Panta runtime.
const paths = ["src", "vendor", "package.json", "bun.lock", "tsconfig.json",
  "Dockerfile", "railway.json", ".dockerignore"];
function run(command: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(command, args, { cwd: root, input, timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    // Never dump arbitrary build output, env values or command error causes.
    throw new Error(`Source export validation failed at ${command}; nothing was uploaded`);
  }
  return result.stdout;
}

const revision = run("git", ["rev-parse", "HEAD"]).toString().trim();
run("git", ["diff", "--exit-code", "HEAD", "--", ...paths]);
if (run("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths]).length) {
  throw new Error("Uncommitted runtime files exist; commit the intended source before export");
}
const inventory = run("git", ["ls-tree", "-r", "--name-only", revision, "--", ...paths])
  .toString().trim().split("\n");
if (inventory.some(path => /(^|\/)(\.env(?:\.|$)|.*(?:keypair|service-account|firebase-adminsdk)|.*\.(?:key|pem|jks|keystore)$)/i.test(path))) {
  throw new Error("Credential-like filename in export; nothing was copied or uploaded");
}
for (const required of ["src/index.ts", "vendor/txline/idl/txoracle.json",
  "vendor/chumbucket_arena/chumbucket_arena.json"]) {
  if (!inventory.includes(required)) throw new Error("Required runtime import is missing from the committed export");
}
const archive = run("git", ["archive", "--format=tar", revision, ...paths]);
const artifact = mkdtempSync(join(tmpdir(), "chumbucket-calls-source-"));
run("tar", ["-x", "-C", artifact], archive);
// Separate output directory: generated diagnostics must not enter the deploy.
const validation = mkdtempSync(join(tmpdir(), "chumbucket-calls-import-check-"));
run(process.execPath, ["--no-env-file", "build", join(artifact, "src/index.ts"),
  "--target=bun", "--packages", "external", "--outdir", validation]);
console.log(JSON.stringify({ revision, artifact, validation, files: inventory.length,
  archiveSha256: createHash("sha256").update(archive).digest("hex"),
  importGraphValidated: true, deployed: false }));
