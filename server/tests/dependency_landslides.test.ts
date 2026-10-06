// ── A dependency that breaks the platform underneath it ─────────────────────
// Found by upgrading jsdom 26 → 30 for this review. The upgrade looked routine
// (`npm ls` clean, the whole suite green) and cost an afternoon, because of
// this:
//
//     before importing jsdom ->  200 {"got":11,"cl":"11"}
//     after  importing jsdom ->  FAILED: invalid content-length header
//
// jsdom 30 depends on `undici` (^8), which lands a *second* copy of the HTTP
// client in node_modules next to the one built into Node — and `fetch` in this
// process starts being served by it. That copy refuses a hand-written
// `Content-Length` header. The server imports jsdom at start-up for the page
// reader, so every subsequent `fetch` in the process inherited the broken
// client: the Gemini file upload and the YouTube video upload both failed with
// "fetch failed", and the visible symptom was one unrelated test going red.
//
// So the upgrade was reverted, and this file is the tripwire. It is not testing
// jsdom — it is testing that a *dependency of this package* has not reached in
// and changed how the process talks to the network, which is a thing no other
// test in this suite can see.
import http from "node:http";
import { describe, expect, it } from "vitest";

/** A loopback server that echoes back the Content-Length it was sent. */
async function echoServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let received = 0;
    req.on("data", (chunk: Buffer) => (received += chunk.length));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received, contentLength: req.headers["content-length"] ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/echo`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the process's own fetch", () => {
  it("still works with an explicit Content-Length, and after importing jsdom", async () => {
    // The order matters: this is the order the server does it in — jsdom is
    // loaded for the reader long before a file is uploaded to Gemini.
    const { url, close } = await echoServer();
    try {
      const payload = Buffer.from("hello world");
      const body = new Uint8Array(payload);

      const before = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "Content-Length": String(body.length) },
        body,
      });
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual({ received: payload.length, contentLength: String(payload.length) });

      // The page reader's dependency. If a future bump brings undici along
      // again, the next line is the one that goes red — with this file's name
      // in the failure, instead of a mystery in the upload tests.
      await import("jsdom");

      const after = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "Content-Length": String(body.length) },
        body,
      });
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ received: payload.length, contentLength: String(payload.length) });
    } finally {
      await close();
    }
  });

  it("has no second HTTP client sitting in node_modules", () => {
    // The direct check, and the one that explains itself in a failure message.
    // jsdom 26 uses the platform's own client; jsdom 30 installs undici.
    const resolve = (name: string): string => {
      try {
        return require.resolve(name, { paths: [__dirname] });
      } catch {
        return "";
      }
    };
    expect(resolve("undici/package.json"), "a second copy of undici is installed — see the note at the top of this file").toBe("");
  });
});
