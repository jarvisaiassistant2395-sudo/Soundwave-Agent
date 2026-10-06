// ── One app, one Content-Security-Policy ────────────────────────────────────
// The policy is enforced in three places that cannot import each other: helmet
// in this server (the packaged desktop app and any server-served SPA), a
// hand-written copy in deploy/nginx.conf (the docker-compose deployment), and a
// <meta> tag in mobile/index.html (the phone app). They had already drifted —
// nginx allowed 'unsafe-inline' styles and framed the app at 'self', so a
// library that injects a <style> element at runtime was dropped in the desktop
// app and worked on the web deployment.
//
// These tests read the real files and compare them to the real helmet header,
// so the drift cannot come back quietly. The phone is allowed one deliberate
// difference: `connect-src` must reach http://<lan-ip>:47800 for the PC.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cspHeaderValue } from "../src/lib/security.js";

const repoRoot = path.resolve(__dirname, "..", "..");

/** The header helmet actually sets, read off a real response. */
async function helmetHeader(): Promise<string> {
  const { securityHeaders } = await import("../src/lib/security.js");
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
  await new Promise<void>((resolve) => securityHeaders({} as never, res as never, (() => resolve()) as never));
  return headers["content-security-policy"] ?? "";
}

function directivesOf(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    out[name] = space === -1 ? "" : trimmed.slice(space + 1).trim();
  }
  return out;
}

describe("the Content-Security-Policy", () => {
  it("is the same string helmet serves and cspHeaderValue() describes", async () => {
    expect(await helmetHeader()).toBe(cspHeaderValue());
  });

  it("does not let anything inject a script, and never frames the app", async () => {
    const directives = directivesOf(await helmetHeader());
    expect(directives["script-src"]).toBe("'self'");
    expect(directives["script-src"]).not.toContain("unsafe-inline");
    expect(directives["script-src"]).not.toContain("unsafe-eval");
    expect(directives["script-src-attr"]).toBe("'none'");
    expect(directives["frame-ancestors"]).toBe("'none'");
    expect(directives["object-src"]).toBe("'none'");
  });

  it("is mirrored exactly by deploy/nginx.conf", async () => {
    const nginx = fs.readFileSync(path.join(repoRoot, "deploy", "nginx.conf"), "utf8");
    const line = nginx.split("\n").find((l) => l.includes("Content-Security-Policy"));
    expect(line, "nginx.conf has no CSP header").toBeTruthy();
    const value = /"([^"]+)"/.exec(line!)![1]!;
    expect(directivesOf(value)).toEqual(directivesOf(await helmetHeader()));
  });

  it("is carried by the phone app too, with only connect-src widened for the PC", () => {
    const html = fs.readFileSync(path.join(repoRoot, "mobile", "index.html"), "utf8");
    const meta = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html);
    expect(meta, "mobile/index.html has no CSP meta tag").toBeTruthy();
    const phone = directivesOf(meta![1]!);
    const server = directivesOf(cspHeaderValue());

    // The phone needs plain http to the PC on the LAN (the request and the
    // answer are encrypted inside — see mobile/src/lib/protocol.ts), and no
    // server-side header can be attached to a Capacitor WebView.
    expect(phone["connect-src"]).toContain("http:");
    delete phone["connect-src"];
    delete server["connect-src"];
    // What is left must match: no injected scripts, nowhere to frame the app.
    expect(phone["script-src"]).toBe(server["script-src"]);
    expect(phone["object-src"]).toBe(server["object-src"]);
    expect(phone["base-uri"]).toBe(server["base-uri"]);
    expect(phone["script-src"]).not.toContain("unsafe-inline");
  });
});
