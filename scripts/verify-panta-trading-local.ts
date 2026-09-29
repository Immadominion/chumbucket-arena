/** Bounded, synthetic-only PostgreSQL verification. Run with:
 * bun --no-env-file scripts/verify-panta-trading-local.ts --run
 * Owns one fresh mktemp cluster and database; never loads app configuration.
 */
import { SQL } from "bun";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

if (process.argv.length !== 3 || process.argv[2] !== "--run") {
  throw new Error("Explicit --run required; use bun --no-env-file (local synthetic data only)");
}
process.umask(0o077);
const pgBin = "/opt/homebrew/opt/postgresql@15/bin";
const admin = "panta_trading_test_admin";
const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]!]] : []));

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function command(executable: string, args: string[], allowed = [0]) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 20000 });
  check(result.status !== null && allowed.includes(result.status),
    `${executable.split("/").pop()} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result;
}
const version = command(join(pgBin, "postgres"), ["--version"]).stdout.trim();
check(/PostgreSQL\) 15\./.test(version), "Only the specified PostgreSQL 15 installation is permitted");
const scratch = realpathSync(command("/usr/bin/mktemp", ["-d", "/private/tmp/chumbucket-panta-trading.XXXXXXXX"]).stdout.trim());
check(/^\/private\/tmp\/chumbucket-panta-trading\.[A-Za-z0-9]{8}$/.test(scratch), "Unexpected scratch directory");
check(statSync(scratch).uid === process.getuid?.() && (statSync(scratch).mode & 0o777) === 0o700,
  "Scratch directory must belong to this user and be owner-only");
const data = join(scratch, "data");
const database = `chumbucket_panta_trading_test_${randomBytes(6).toString("hex")}`;
let initialized = false;
let attemptedStart = false;
let db: SQL | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted = false;
const interrupt = () => { interrupted = true; child?.kill("SIGTERM"); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  check(address && typeof address !== "string", "Missing random loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  check(!interrupted, "Verification interrupted");
  command(join(pgBin, "initdb"), ["-D", data, "-U", admin, "-A", "trust", "--no-locale", "--encoding=UTF8"]);
  initialized = true;
  attemptedStart = true;
  command(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(scratch, "postgres.log"), "-w", "-t", "10", "-o",
    `-k ${scratch} -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=12 -c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000`, "start"]);
  const base = `postgres://${admin}@127.0.0.1:${port}`;
  db = new SQL(`${base}/postgres`, { max: 1 });
  const [server] = await db`SELECT current_setting('data_directory') AS dir, version() AS version`;
  check(server.dir === data && /PostgreSQL 15\./.test(server.version), "Cluster identity mismatch");
  // This identifier consists exclusively of the fixed prefix and generated hex.
  await db.unsafe(`CREATE DATABASE ${database} TEMPLATE template0`);
  await db.end(); db = undefined;
  console.log(`LOCAL ${version}; data_directory=${data}; loopback_port=${port}; database=${database}`);
  check(!interrupted, "Verification interrupted");
  const testProcess = Bun.spawn([process.execPath, "--no-env-file", "test", "./tests/pantaTrading.postgres.test.ts", "--timeout", "15000"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...env, PANTA_TRADING_TEST_DATABASE_URL: `${base}/${database}` },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  child = testProcess;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child?.kill("SIGTERM"); }, 90000);
  const code = await testProcess.exited;
  clearTimeout(deadline);
  check(!timedOut, "Scoped test process exceeded the 90-second bound");
  check(!interrupted, "Verification interrupted");
  // A second opt-in on this now-populated target must refuse before DDL/data
  // writes. This also verifies the fresh/empty-target fence with real PG.
  const refusal = Bun.spawn([process.execPath, "--no-env-file", "test", "./tests/pantaTrading.postgres.test.ts", "--timeout", "15000"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...env, PANTA_TRADING_TEST_DATABASE_URL: `${base}/${database}` },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  child = refusal;
  let refusalTimedOut = false;
  const refusalDeadline = setTimeout(() => { refusalTimedOut = true; child?.kill("SIGTERM"); }, 10000);
  const [refusalCode, refusalOut, refusalErr] = await Promise.all([
    refusal.exited, new Response(refusal.stdout).text(), new Response(refusal.stderr).text(),
  ]);
  clearTimeout(refusalDeadline);
  check(!refusalTimedOut && !interrupted && refusalCode === 1
    && /Require a new empty database; refusing to overwrite existing objects/.test(refusalOut + refusalErr),
    "Populated target was not safely refused before writes");
  console.log("PASS target fence: a second opt-in refused the populated database before writes");
  check(code === 0, `Scoped PostgreSQL tests exited ${code}`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  try { await db?.end(); } finally {
    if (initialized && attemptedStart) {
      const status = command(join(pgBin, "pg_ctl"), ["-D", data, "status"], [0, 3]);
      if (status.status === 0) {
        const stopped = command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "10", "stop"]);
        console.log(stopped.stdout.trim());
      }
      const statusAfter = command(join(pgBin, "pg_ctl"), ["-D", data, "status"], [3]);
      check(!existsSync(join(data, "postmaster.pid")), "Own cluster still has postmaster.pid");
      console.log(`STOP EVIDENCE: pg_ctl status exit=${statusAfter.status}; ${statusAfter.stdout.trim()}; postmaster.pid absent`);
    }
    console.log(`Retained owner-only synthetic scratch: ${scratch}`);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
