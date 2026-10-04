// node --test test/check-dlls.test.mjs — the "runs on a clean PC" DLL gate, on tiny synthetic PE files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyMissingRuntime, isMsvcRuntime, missingDlls, peImports } from "../check-dlls.mjs";

/** A minimal PE32+ image whose import (and delay-import) tables name the given DLLs. */
function makePe(imports, delayImports = []) {
  const buf = Buffer.alloc(0x800);
  buf.writeUInt16LE(0x5a4d, 0); // "MZ"
  const pe = 0x80;
  buf.writeUInt32LE(pe, 0x3c);
  buf.writeUInt32LE(0x00004550, pe); // "PE\0\0"
  buf.writeUInt16LE(0x8664, pe + 4); // x64
  buf.writeUInt16LE(1, pe + 6); // one section
  const optSize = 240;
  buf.writeUInt16LE(optSize, pe + 20);
  const opt = pe + 24;
  buf.writeUInt16LE(0x20b, opt); // PE32+
  const dirs = opt + 112;
  buf.writeUInt32LE(16, dirs - 4);
  const sec = opt + optSize; // file 0x200..0x800 ↔ RVA 0x1000..0x1600
  buf.writeUInt32LE(0x600, sec + 8);
  buf.writeUInt32LE(0x1000, sec + 12);
  buf.writeUInt32LE(0x600, sec + 16);
  buf.writeUInt32LE(0x200, sec + 20);
  const rva = (at) => at - 0x200 + 0x1000;
  let nameAt = 0x400;
  const putName = (name) => {
    buf.write(`${name}\0`, nameAt, "latin1");
    const r = rva(nameAt);
    nameAt += name.length + 1;
    return r;
  };
  imports.forEach((name, i) => {
    buf.writeUInt32LE(putName(name), 0x200 + i * 20 + 12);
    buf.writeUInt32LE(rva(0x3f0), 0x200 + i * 20 + 16);
  });
  buf.writeUInt32LE(rva(0x200), dirs + 8);
  buf.writeUInt32LE((imports.length + 1) * 20, dirs + 12);
  if (delayImports.length) {
    delayImports.forEach((name, i) => buf.writeUInt32LE(putName(name), 0x300 + i * 32 + 4));
    buf.writeUInt32LE(rva(0x300), dirs + 13 * 8);
    buf.writeUInt32LE((delayImports.length + 1) * 32, dirs + 13 * 8 + 4);
  }
  return buf;
}

/** An engine folder shaped like whisper.cpp's MSVC build, plus a fake System32. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-dlls-"));
  const app = path.join(root, "whisper");
  const sys = path.join(root, "System32");
  fs.mkdirSync(app);
  fs.mkdirSync(sys);
  const put = (dir, name, imports, delayed) => fs.writeFileSync(path.join(dir, name), makePe(imports, delayed));
  put(app, "whisper-cli.exe", ["whisper.dll", "MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "KERNEL32.dll"]);
  put(app, "whisper.dll", ["ggml.dll", "MSVCP140.dll", "KERNEL32.dll"]);
  put(app, "ggml.dll", ["ggml-base.dll", "KERNEL32.dll"]);
  put(app, "ggml-base.dll", ["KERNEL32.dll"], ["VCOMP140.DLL"]); // OpenMP, delay-loaded, upper case
  put(sys, "msvcp140.dll", ["VCRUNTIME140.dll", "concrt140.dll", "KERNEL32.dll"]); // pulls in a 2nd round
  put(sys, "vcruntime140.dll", ["KERNEL32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"]);
  put(sys, "vcruntime140_1.dll", ["VCRUNTIME140.dll", "KERNEL32.dll"]);
  put(sys, "vcomp140.dll", ["KERNEL32.dll"]);
  put(sys, "concrt140.dll", ["VCRUNTIME140.dll", "KERNEL32.dll"]);
  put(sys, "d3dcompiler_47.dll", ["KERNEL32.dll"]); // not the C++ runtime: never copied
  return { root, app, sys, put };
}

test("reads normal and delay-loaded imports", () => {
  assert.deepEqual(peImports(makePe(["a.dll", "KERNEL32.dll"], ["VCOMP140.DLL"])), ["a.dll", "KERNEL32.dll", "VCOMP140.DLL"]);
  assert.throws(() => peImports(Buffer.from("not a dll, just text padded out to sixty-four bytes or so....")), /not a PE file/);
});

test("only the Microsoft C++ runtime counts as redistributable", () => {
  for (const n of ["vcruntime140.dll", "VCRUNTIME140_1.dll", "msvcp140.dll", "msvcp140_atomic_wait.dll", "VCOMP140.DLL", "concrt140.dll"]) assert.ok(isMsvcRuntime(n), n);
  for (const n of ["SDL2.dll", "ggml.dll", "vcomp.exe", "msvcrt.dll", "d3dcompiler_47.dll"]) assert.ok(!isMsvcRuntime(n), n);
});

test("a missing C++ runtime is flagged even though the build machine has it", (t) => {
  const { root, app } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = missingDlls(app).flatMap((r) => r.missing.map((m) => m.toLowerCase()));
  assert.deepEqual([...new Set(missing)].sort(), ["msvcp140.dll", "vcomp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);
});

test("--copy-runtime-from copies exactly what is imported (any case, delay-loaded, and their own imports)", (t) => {
  const { root, app, sys } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copied = copyMissingRuntime(app, sys);
  assert.deepEqual([...copied].sort(), ["concrt140.dll", "msvcp140.dll", "vcomp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);
  assert.ok(!fs.existsSync(path.join(app, "d3dcompiler_47.dll")));
  assert.deepEqual(missingDlls(app).filter((r) => r.missing.length), []);
  assert.deepEqual(copyMissingRuntime(app, sys), [], "second run has nothing left to copy");
});

test("anything that is neither shipped, Windows, nor the C++ runtime still fails the gate", (t) => {
  const { root, app, sys, put } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(app, "ggml-cpu-haswell.dll", ["ggml-base.dll", "SDL2.dll", "KERNEL32.dll"]);
  copyMissingRuntime(app, sys);
  assert.deepEqual(
    missingDlls(app).filter((r) => r.missing.length).map((r) => [r.file, r.missing]),
    [["ggml-cpu-haswell.dll", ["SDL2.dll"]]],
  );
});
