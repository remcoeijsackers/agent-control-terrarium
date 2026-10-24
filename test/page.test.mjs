// The built page: one self-contained file that talks to Agent Control only through the bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, manifest } from "./helpers.mjs";

const html = readFileSync(join(root, "ui", "index.html"), "utf8");

test("every nav page exists", () => {
  for (const n of manifest.nav) assert.ok(readFileSync(join(root, "ui", n.page), "utf8").length > 1000);
});

test("the page loads nothing from elsewhere", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /\bfetch\(/);
});

test("the page uses the bridge and only calls this plugin's declared routes", () => {
  for (const t of ["agent-control:ready", "agent-control:request", "agent-control:init", "agent-control:response", "agent-control:resize"]) assert.ok(html.includes(t), t);
  const calls = [...html.matchAll(/bridge\.call\("(GET|POST|PUT|PATCH|DELETE)", [`"](\/[a-z/]*)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    const [method, path] = c.split(" ");
    assert.ok(manifest.routes.some((r) => r.method === method && (r.path === path || r.path.replace(/:[a-z]+$/, "") === path)), `${c} is declared`);
  }
});

test("the generator is inlined, not imported", () => {
  assert.ok(html.includes("export function makeWorld"));
  assert.doesNotMatch(html, /^\s*import\s/m);
});
