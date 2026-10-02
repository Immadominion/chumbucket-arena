/** Bounded, synthetic-only PostgreSQL verification of the market proposals
 * migration. Run with:
 *   bun --no-env-file scripts/verify-market-proposals-local.ts --run
 * Owns one fresh mktemp cluster on loopback, runs the opt-in test, stops the
 * cluster and removes its data. Never loads app configuration or touches a
 * shared database.
 */
import { SQL } from "bun";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

if (process.argv.length !== 3 || process.argv[2] !== "--run") {
  throw new Error("Explicit --run required; use bun --no-env-file (local synthetic data only)");
}
process.umask(0o077);
const pgBin = "/opt/homebrew/opt/postgresql@15/bin";
const admin = "market_proposals_test_admin";
const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
const check: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
function command(executable: string, args: string[], allowed = [0]) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 20_000 });
  check(result.status !== null && allowed.includes(result.status), `${executable.split("/").pop()} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result;
}
check(/PostgreSQL\) 15\./.test(command(join(pgBin, "postgres"), ["--version"]).stdout), "PostgreSQL 15 is required");
const scratch = realpathSync(command("/usr/bin/mktemp", ["-d", "/private/tmp/chumbucket-market-proposals.XXXXXXXX"]).stdout.trim());
const data = join(scratch, "data");
const database = `chumbucket_market_proposals_test_${randomBytes(6).toString("hex")}`;
let started = false;
try {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  check(address && typeof address !== "string", "No loopback port");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  command(join(pgBin, "initdb"), ["-D", data, "-U", admin, "-A", "trust", "--no-locale", "--encoding=UTF8"]);
  command(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(scratch, "postgres.log"), "-w", "-t", "10", "-o",
    `-k ${scratch} -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=12 -c statement_timeout=10000`, "start"]);
  started = true;
  const base = `postgres://${admin}@127.0.0.1:${port}`;
  const db = new SQL(`${base}/postgres`, { max: 1 });
  await db.unsafe(`CREATE DATABASE ${database} TEMPLATE template0`);
  await db.end();
  const test = Bun.spawn([process.execPath, "--no-env-file", "test", "./tests/marketProposals.postgres.test.ts", "--timeout", "15000"], {
    cwd: join(import.meta.dir, ".."), env: { ...env, MARKET_PROPOSALS_TEST_DATABASE_URL: `${base}/${database}`,
      ...(process.env.MARKET_PROPOSALS_MIGRATION ? { MARKET_PROPOSALS_MIGRATION: process.env.MARKET_PROPOSALS_MIGRATION } : {}) },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const deadline = setTimeout(() => test.kill("SIGTERM"), 90_000);
  const code = await test.exited;
  clearTimeout(deadline);
  check(code === 0, `Scoped PostgreSQL tests exited ${code}`);
  console.log("PASS market proposals migration on a fresh PostgreSQL 15 cluster");
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (started) command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "10", "stop"], [0, 1]);
  check(!existsSync(join(data, "postmaster.pid")), "Cluster still running");
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Stopped and removed ${scratch}`);
}
