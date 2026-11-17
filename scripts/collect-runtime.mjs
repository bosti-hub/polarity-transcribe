#!/usr/bin/env node
// Collect the DLLs that must sit next to the Windows executable into src-tauri/runtime/.
//
//   node scripts/collect-runtime.mjs [rust-target-triple]
//
// Why: the installer has to work on a laptop that has never seen a developer tool.
//   - DirectML.dll      The ONNX Runtime build used for telling voices apart is linked against
//                       DirectML. Windows ships its own copy, but an older one; ours matches.
//   - VC++ runtime      whisper.cpp and ONNX Runtime are C++ and use the dynamic Visual C++
//                       runtime. Microsoft allows shipping these DLLs "app-local" (next to the
//                       exe), which avoids running the VC++ redistributable installer.
//
// Run it after a release build of the engine (cargo puts DirectML.dll in the target folder) and
// before `tauri build --config src-tauri/tauri.release.windows.conf.json`.
// On other systems this does nothing.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "runtime");
const triple = process.argv[2];

if (process.platform !== "win32") {
  console.log("[collect-runtime] nothing to do on this system");
  process.exit(0);
}

const fail = (message) => {
  console.error(`[collect-runtime] error: ${message}`);
  process.exit(1);
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// --- DirectML.dll, copied into the target folder by the ONNX Runtime build script ------------
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, "target");
const candidates = [triple && join(targetDir, triple, "release"), join(targetDir, "release")].filter(Boolean);
const directml = candidates.map((dir) => join(dir, "DirectML.dll")).find(existsSync);
if (!directml) fail(`DirectML.dll not found in ${candidates.join(" or ")}; build the engine in release mode first`);
copyFileSync(directml, join(out, "DirectML.dll"));

// --- Visual C++ runtime, from the Visual Studio installation that built the app ---------------
const CRT = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

function redistDirs() {
  const dirs = [];
  if (process.env.VCToolsRedistDir) dirs.push(process.env.VCToolsRedistDir);
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (existsSync(vswhere)) {
    const found = execFileSync(vswhere, ["-products", "*", "-property", "installationPath"], { encoding: "utf8" });
    for (const install of found.split(/\r?\n/).filter(Boolean)) {
      const base = join(install, "VC", "Redist", "MSVC");
      if (!existsSync(base)) continue;
      // Version folders such as 14.44.35112; newest first.
      const versions = readdirSync(base)
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) dirs.push(join(base, v));
    }
  }
  return dirs;
}

function crtDir() {
  for (const dir of redistDirs()) {
    const x64 = join(dir, "x64");
    if (!existsSync(x64)) continue;
    for (const name of readdirSync(x64)) {
      const candidate = join(x64, name);
      if (/^Microsoft\.VC\d+\.CRT$/.test(name) && CRT.every((f) => existsSync(join(candidate, f)))) return candidate;
    }
  }
  return null;
}

const crt = crtDir();
if (!crt) fail("the Visual C++ redistributable DLLs were not found (is the MSVC toolset installed?)");
for (const name of CRT) copyFileSync(join(crt, name), join(out, name));

for (const name of readdirSync(out)) console.log(`[collect-runtime] ${name}  ${statSync(join(out, name)).size} bytes`);
console.log(`[collect-runtime] from ${directml}\n[collect-runtime] from ${crt}`);
