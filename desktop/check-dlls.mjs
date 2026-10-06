// Make sure a folder of Windows binaries runs on a CLEAN PC: every DLL that
// an .exe/.dll in it imports must either ship in the same folder or be part
// of Windows itself. (Build machines have the Visual C++ runtime installed,
// so "it runs in CI" alone would not catch a missing vcruntime140.dll.)
//
//   node check-dlls.mjs bin/whisper [--copy-runtime-from C:\Windows\System32]
//   (tested by test/check-dlls.test.mjs)
//
// With --copy-runtime-from, missing Microsoft C++ runtime DLLs (vcruntime*,
// msvcp*, vcomp*, concrt*) are copied app-locally from that folder first —
// Microsoft allows redistributing them next to the exe. Reads the PE import
// and delay-import tables directly — no Windows SDK needed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** DLLs every supported Windows (10/11) has. API sets (api-ms-win-*, ext-ms-*) are always satisfied by the OS. */
const WINDOWS_DLLS = new Set(
  [
    "kernel32.dll",
    "kernelbase.dll",
    "ntdll.dll",
    "user32.dll",
    "gdi32.dll",
    "advapi32.dll",
    "shell32.dll",
    "shlwapi.dll",
    "ole32.dll",
    "oleaut32.dll",
    "comdlg32.dll",
    "comctl32.dll",
    "ws2_32.dll",
    "winmm.dll",
    "version.dll",
    "setupapi.dll",
    "imm32.dll",
    "bcrypt.dll",
    "crypt32.dll",
    "dbghelp.dll",
    "psapi.dll",
    "powrprof.dll",
    "rpcrt4.dll",
    "secur32.dll",
    "userenv.dll",
    "uxtheme.dll",
    "dwmapi.dll",
    "iphlpapi.dll",
    "ucrtbase.dll",
    "msvcrt.dll",
    "d3d11.dll",
    "d3d12.dll",
    "dxgi.dll",
    "opengl32.dll",
    "vulkan-1.dll",
    "cfgmgr32.dll",
    "normaliz.dll",
    "wldap32.dll",
    "hid.dll",
  ].map((n) => n.toLowerCase()),
);

export function isWindowsDll(name) {
  const n = name.toLowerCase();
  return WINDOWS_DLLS.has(n) || n.startsWith("api-ms-win-") || n.startsWith("ext-ms-");
}

/** Names of the DLLs a PE file imports (normal + delay-loaded). */
export function peImports(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file (no MZ header)");
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw new Error("not a PE file (no PE signature)");
  const sectionCount = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  if (Number.isNaN(dirs)) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  const dirCount = buf.readUInt32LE(dirs - 4);
  const dir = (i) => (i < dirCount ? { rva: buf.readUInt32LE(dirs + i * 8), size: buf.readUInt32LE(dirs + i * 8 + 4) } : { rva: 0, size: 0 });

  const sections = [];
  const firstSection = opt + optSize;
  for (let i = 0; i < sectionCount; i++) {
    const s = firstSection + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const offset = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.vsize);
    return s ? rva - s.va + s.raw : -1;
  };
  const cstring = (rva) => {
    const at = offset(rva);
    if (at < 0) return null;
    const end = buf.indexOf(0, at);
    return buf.toString("latin1", at, end < 0 ? buf.length : end);
  };

  const names = new Set();
  const imports = dir(1);
  if (imports.rva) {
    for (let at = offset(imports.rva); at >= 0 && at + 20 <= buf.length; at += 20) {
      const nameRva = buf.readUInt32LE(at + 12);
      const thunk = buf.readUInt32LE(at + 16);
      if (!nameRva && !thunk) break;
      const name = cstring(nameRva);
      if (name) names.add(name);
    }
  }
  const delayed = dir(13);
  if (delayed.rva) {
    for (let at = offset(delayed.rva); at >= 0 && at + 32 <= buf.length; at += 32) {
      const nameRva = buf.readUInt32LE(at + 4);
      if (!nameRva) break;
      const name = cstring(nameRva);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Every binary in `dir` → the imports that neither ship with it nor come with Windows. */
export function missingDlls(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.(exe|dll)$/i.test(f));
  const present = new Set(files.map((f) => f.toLowerCase()));
  const report = [];
  for (const file of files) {
    const imports = peImports(fs.readFileSync(path.join(dir, file)));
    const missing = imports.filter((d) => !present.has(d.toLowerCase()) && !isWindowsDll(d));
    report.push({ file, imports, missing });
  }
  return report;
}

/** The Microsoft C++ runtime (redistributable app-locally). */
export function isMsvcRuntime(name) {
  return /^(vcruntime|msvcp|vcomp|concrt)\d.*\.dll$/i.test(name);
}

/** Copy missing C++ runtime DLLs from `sourceDir` into `dir` (repeats for their own imports). */
export function copyMissingRuntime(dir, sourceDir) {
  // Import tables often say "VCOMP140.DLL" while the file is "vcomp140.dll": match names case-insensitively.
  const available = new Map(fs.readdirSync(sourceDir).map((f) => [f.toLowerCase(), f]));
  const copied = [];
  for (let round = 0; round < 5; round++) {
    const wanted = new Set(missingDlls(dir).flatMap((r) => r.missing).filter(isMsvcRuntime).map((n) => n.toLowerCase()));
    const found = [...wanted].filter((name) => available.has(name));
    if (!found.length) break;
    for (const name of found) {
      fs.copyFileSync(path.join(sourceDir, available.get(name)), path.join(dir, name));
      copied.push(name);
    }
  }
  return copied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? "bin/whisper");
  if (!fs.existsSync(dir)) {
    console.error(`[check-dlls] no such folder: ${dir}`);
    process.exit(1);
  }
  const fromFlag = process.argv.indexOf("--copy-runtime-from");
  if (fromFlag > 0 && process.argv[fromFlag + 1]) {
    const copied = copyMissingRuntime(dir, process.argv[fromFlag + 1]);
    console.log(`[check-dlls] C++ runtime copied app-locally: ${copied.length ? copied.join(", ") : "nothing was missing"}`);
  }
  const report = missingDlls(dir);
  let bad = 0;
  for (const { file, imports, missing } of report) {
    console.log(`[check-dlls] ${file}: ${imports.join(", ") || "(no imports)"}`);
    if (missing.length) {
      bad++;
      console.error(`[check-dlls] ✗ ${file} needs ${missing.join(", ")} — not in ${path.basename(dir)}/ and not part of Windows`);
    }
  }
  if (!report.length) {
    console.error(`[check-dlls] no .exe/.dll files in ${dir}`);
    process.exit(1);
  }
  if (bad) process.exit(1);
  console.log(`[check-dlls] ✓ ${report.length} binaries in ${path.basename(dir)}/ only need each other and Windows itself`);
}
