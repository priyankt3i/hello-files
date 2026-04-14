#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const workerScript = resolve(repoRoot, "services/indexer/fschat_indexer/worker.py");
const appResourceRoot = resolve(repoRoot, "apps/desktop/resources/indexer");
const buildRoot = resolve(repoRoot, "apps/desktop/.indexer-build");
const pyInstallerConfigDir = resolve(buildRoot, "pyinstaller-config");

const platformKey = platformName(process.platform);
const archKey = process.arch;
const targetDir = resolve(appResourceRoot, `${platformKey}-${archKey}`);
const binaryName = process.platform === "win32" ? "fschat-indexer.exe" : "fschat-indexer";

if (!existsSync(workerScript)) {
  fail(`Worker script not found: ${workerScript}`);
}

const python = detectPython();
ensurePyInstaller(python);

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(pyInstallerConfigDir, { recursive: true });

const pyInstallerArgs = [
  ...python.args,
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--name",
  "fschat-indexer",
  "--distpath",
  targetDir,
  "--workpath",
  resolve(buildRoot, "work"),
  "--specpath",
  resolve(buildRoot, "spec"),
  workerScript
];

console.log(`[indexer] Building ${platformKey}-${archKey} binary with ${python.command} ${python.args.join(" ")}`.trim());
const build = spawnSync(python.command, pyInstallerArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    PYINSTALLER_CONFIG_DIR: pyInstallerConfigDir
  }
});
if (build.status !== 0) {
  fail("PyInstaller build failed.");
}

const builtBinary = resolve(targetDir, binaryName);
if (!existsSync(builtBinary)) {
  fail(`Expected binary not found: ${builtBinary}`);
}

console.log(`[indexer] Output: ${builtBinary}`);

function detectPython() {
  const explicit = process.env.FSCHAT_PYTHON_BIN?.trim();
  const candidates = [];
  if (explicit) {
    candidates.push({ command: explicit, args: [] });
  }
  if (process.platform === "win32") {
    candidates.push({ command: "python", args: [] }, { command: "py", args: ["-3"] });
  } else {
    candidates.push({ command: "python3", args: [] }, { command: "python", args: [] });
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, "--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  const attempted = candidates.map((entry) => [entry.command, ...entry.args].join(" ")).join(", ");
  fail(`Python not found. Install Python 3 or set FSCHAT_PYTHON_BIN. Tried: ${attempted}`);
}

function ensurePyInstaller(python) {
  const probe = spawnSync(python.command, [...python.args, "-m", "PyInstaller", "--version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) {
    return;
  }

  fail(
    "PyInstaller is not installed for the selected Python. Run: " +
      `${python.command} ${python.args.join(" ")} -m pip install pyinstaller`
  );
}

function platformName(platform) {
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "darwin") {
    return "macos";
  }
  return "linux";
}

function fail(message) {
  console.error(`[indexer] ${message}`);
  process.exit(1);
}
