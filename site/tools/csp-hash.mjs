#!/usr/bin/env node
/**
 * Prints the SHA-256 hash of the JSON-LD block in index.html, so the Content
 * Security Policy in server.mjs can allow it without opening the door to all
 * inline scripts.
 *
 * Run it if you edit the structured data (the "application/ld+json" block) and
 * it stops working / the browser console complains about CSP:
 *
 *   node tools/csp-hash.mjs
 *
 * Then paste the hash into the script-src line of baseHeaders() in server.mjs.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../index.html", import.meta.url));
const html = readFileSync(file, "utf8");

const match = html.match(
  /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
);

if (!match) {
  console.error("No application/ld+json block found in index.html");
  process.exit(1);
}

const hash = createHash("sha256").update(match[1], "utf8").digest("base64");
console.log(`'sha256-${hash}'`);
