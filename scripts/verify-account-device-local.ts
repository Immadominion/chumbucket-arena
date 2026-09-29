/** Builds the existing Flutter Profile/Settings flow in a disposable, separate
 * Android package, against verify-account-link-local.ts's fresh database.
 * Explicit --run <adb-serial>; no production config or credential files read.
 * Temporary host files are generated artifacts, not edits to either checkout.
 */
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const serial = process.argv[3];
if (process.argv[2] !== "--run" || !serial || !/^[A-Za-z0-9_.:-]+$/.test(serial)) {
  throw new Error("Explicit --run <connected-adb-serial> required");
}
const flutter = process.env.FLUTTER_BIN;
const adb = process.env.ADB_BIN;
const rest = process.env.POSTGREST_BIN;
if (!flutter || !adb || !rest) throw new Error("Set FLUTTER_BIN, ADB_BIN, POSTGREST_BIN executable paths");
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "USER"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]!]] : []));
const mobile = resolve(import.meta.dir, "../../chumbucket-social-calls");
const root = mkdtempSync(join(tmpdir(), "chumbucket-account-device-"));
const appId = "dev.cleva.chumbucket.localtest";
const forwards: number[] = [];
let local: ReturnType<typeof Bun.spawn> | undefined;
let installedByRun = false;
let localExit: Promise<number> | undefined;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function command(args: string[], cwd?: string, quiet = false): Promise<string> {
  const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (!quiet && out.trim()) console.log(out.trim());
  // Commands below never receive a credential; do not add env-file flags.
  if (!quiet && err.trim()) console.log(err.trim());
  check(code === 0, "Local test command failed");
  return out;
}
const adbArgs = [adb, "-s", serial];
async function installedAppStamp() {
  const output = await command([...adbArgs, "shell", "dumpsys", "package", "dev.cleva.chumbucket"], undefined, true);
  const stamp = output.split("\n").filter(line => /versionCode=|versionName=|lastUpdateTime=/.test(line)).join("\n");
  check(stamp.includes("versionName="), "Installed Chumbucket must be present for the preservation check");
  return createHash("sha256").update(stamp).digest("hex");
}
const original = await installedAppStamp();
const existingTestApp = await command([...adbArgs, "shell", "pm", "list", "packages", "--user", "0", appId], undefined, true);
const existingPackageDump = await command([...adbArgs, "shell", "dumpsys", "package", appId], undefined, true);
check(!existingTestApp.includes(`package:${appId}`) && !existingPackageDump.includes("versionName="),
  "Separate test package already exists; inspect it before continuing");
try {
  const launched = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "verify-account-link-local.ts"), "--run", "--device"], {
    env: { ...env, POSTGREST_BIN: rest,
      ...(process.env.POSTGRES_BIN_DIR ? { POSTGRES_BIN_DIR: process.env.POSTGRES_BIN_DIR } : {}) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  local = launched;
  localExit = launched.exited;
  const output: string[] = [];
  let gateway = "", bff = "", buffer = "";
  const logs = (async () => {
    for await (const chunk of launched.stdout) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        output.push(line); console.log(line);
        if (line.startsWith("DEVICE_LOCAL_GATEWAY=")) gateway = line.slice(21);
        if (line.startsWith("DEVICE_LOCAL_BFF=")) bff = line.slice(17);
      }
    }
  })();
  // Consume stderr to avoid filling the pipe; no credential-bearing env is inherited.
  const errors = new Response(launched.stderr).text();
  const started = Date.now();
  while ((!gateway || !bff) && Date.now() - started < 30000) await Bun.sleep(50);
  check(gateway && bff, "Local database/BFF failed to become ready");
  const priorForwards = await command([...adbArgs, "reverse", "--list"], undefined, true);
  for (const base of [gateway, bff]) {
    const url = new URL(base);
    check(url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port,
      "Only local listener metadata is allowed");
    const port = Number(url.port);
    check(!priorForwards.split("\n").some(line => line.split(/\s+/)[1] === `tcp:${port}`),
      "Refused existing device reverse mapping");
    await command([...adbArgs, "reverse", `tcp:${port}`, `tcp:${port}`], undefined, true);
    forwards.push(port);
  }
  await command([flutter, "create", "--empty", "--platforms=android", "--org", "dev.cleva.chumbucket",
    "--project-name", "localtest", "--no-pub", root], undefined, true);
  // The test host uses the product's reviewed Android toolchain, not whatever
  // newer template the local Flutter installation happens to generate.
  copyFileSync(join(mobile, "android/gradle/wrapper/gradle-wrapper.properties"), join(root, "android/gradle/wrapper/gradle-wrapper.properties"));
  writeFileSync(join(root, "android/settings.gradle.kts"), readFileSync(join(mobile, "android/settings.gradle.kts"), "utf8")
    .replace(/^\s*id\("com.google.gms.google-services"\).*$/m, ""));
  const mobilePubspec = readFileSync(join(mobile, "pubspec.yaml"), "utf8");
  // Reuse the complete asset/font declarations and dependency overrides, never .env.
  const assets = mobilePubspec.slice(mobilePubspec.lastIndexOf("\nflutter:\n"));
  const overrides = mobilePubspec.slice(mobilePubspec.indexOf("\ndependency_overrides:\n"), mobilePubspec.indexOf("\ndev_dependencies:\n"));
  check(assets.includes("assets/icons/basil/") && !/^\s+-\s+['"]?\.env/m.test(assets), "Unsafe or missing mobile assets");
  writeFileSync(join(root, "pubspec.yaml"), `name: localtest\npublish_to: none\nversion: 0.1.0+1\nenvironment:\n  sdk: ^3.7.0\ndependencies:\n  flutter:\n    sdk: flutter\n  chumbucket:\n    path: ${mobile}\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n  integration_test:\n    sdk: flutter\n${overrides}${assets}`);
  copyFileSync(join(mobile, "pubspec.lock"), join(root, "pubspec.lock"));
  copyFileSync(join(mobile, "shorebird.yaml"), join(root, "shorebird.yaml"));
  symlinkSync(join(mobile, "assets"), join(root, "assets"));
  mkdirSync(join(root, "integration_test"));
  symlinkSync(join(mobile, "tool/device_account_flow_test.dart"), join(root, "integration_test/account_flow_test.dart"));
  const gradlePath = join(root, "android/app/build.gradle.kts");
  let gradle = readFileSync(gradlePath, "utf8");
  check(gradle.includes(`applicationId = "${appId}"`) && gradle.includes("minSdk = flutter.minSdkVersion"), "Unexpected generated Android template");
  gradle = gradle.replace("compileOptions {", "compileOptions {\n        isCoreLibraryDesugaringEnabled = true")
    .replace('id("com.android.application")', 'id("com.android.application")\n    id("kotlin-android")')
    .replace("minSdk = flutter.minSdkVersion", "minSdk = 27");
  writeFileSync(gradlePath, `${gradle}\ndependencies { coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4") }\n`);
  const manifestPath = join(root, "android/app/src/main/AndroidManifest.xml");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('android:label="localtest"',
    'android:label="Chumbucket local test" android:allowBackup="false" android:usesCleartextTraffic="true"'));
  console.log(`Isolated generated test host: ${root}`);
  installedByRun = true; // Any package subsequently installed at this id is this run's artifact.
  await command([flutter, "test", "-d", serial, "--reporter", "expanded",
    `--dart-define=CHUM_LOCAL_DEVICE_GATEWAY=${gateway}`, "integration_test/account_flow_test.dart"], root);
  check(await localExit === 0, "Local database preservation checks failed");
  await logs; await errors;
  check(output.some(line => line.startsWith("PASS account-link device/local integration")), "Missing SQL verification outcome");
  check(await installedAppStamp() === original, "Installed Chumbucket changed");
  console.log("PASS Seeker Profile/Settings continuity; original installed app unchanged");
} finally {
  if (local && local.exitCode === null) { local.kill("SIGTERM"); await localExit; }
  for (const port of forwards) await command([...adbArgs, "reverse", "--remove", `tcp:${port}`], undefined, true);
  if (installedByRun) {
    const current = await command([...adbArgs, "shell", "pm", "list", "packages", "--user", "0", appId], undefined, true);
    if (current.includes(`package:${appId}`)) await command([...adbArgs, "uninstall", appId], undefined, true);
    console.log("Removed this run's separate synthetic test app; generated APK/host retained locally");
  }
}
