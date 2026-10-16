#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
// npm workspaces may hoist Electron to the repo root, so resolve it the way Node would from apps/desktop.
const electronModuleRoot = resolveElectronRoot();
const electronPackagePath = join(electronModuleRoot, "package.json");
const electronPathFile = join(electronModuleRoot, "path.txt");
const electronViteBin = resolve(repoRoot, "node_modules/electron-vite/bin/electron-vite.js");

if (!existsSync(electronPackagePath) || !existsSync(electronPathFile)) {
  fail("Local Electron dependency is missing or its download did not finish. Run `npm install` (or `node node_modules/electron/install.js`) before starting dev.");
}

if (!existsSync(electronViteBin)) {
  fail("electron-vite is missing. Run `npm install` before starting dev.");
}

const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
const electronExecutable = readFileSync(electronPathFile, "utf8").trim();
const electronExecPath = join(electronModuleRoot, "dist", electronExecutable);

if (!existsSync(electronExecPath)) {
  fail(`Local Electron executable not found: ${electronExecPath}`);
}

const childEnv = {
  ...process.env,
  ELECTRON_EXEC_PATH: electronExecPath,
  ELECTRON_MAJOR_VER: String(electronPackage.version).split(".")[0]
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [electronViteBin, "dev"], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: childEnv
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  fail(error.message);
});

function fail(message) {
  console.error(`[desktop-dev] ${message}`);
  process.exit(1);
}

function resolveElectronRoot() {
  for (const candidate of [resolve(desktopRoot, "node_modules/electron"), resolve(repoRoot, "node_modules/electron")]) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return resolve(desktopRoot, "node_modules/electron");
}
