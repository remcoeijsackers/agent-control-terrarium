// Builds ui/index.html: ui-src/page.html with lib/genesis.mjs and ui-src/app.js inlined. Agent Control shows plugin
// pages in a sandboxed frame without a session, so the page cannot load other files and has to be one file.
// `node scripts/build.mjs --check` fails when ui/index.html is not up to date (used in CI).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const parts = { GENESIS: read("lib/genesis.mjs"), APP: read("ui-src/app.js") };
for (const [k, v] of Object.entries(parts)) if (/<\/script/i.test(v)) throw new Error(`${k} contains </script>`);
const html = read("ui-src/page.html").replace(/\/\*(GENESIS|APP)\*\//g, (_m, k) => parts[k]);
const out = join(root, "ui", "index.html");

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch {}
  if (current !== html) { console.error("ui/index.html is out of date: run npm run build"); process.exit(1); }
  console.log("ui/index.html is up to date");
} else {
  writeFileSync(out, html);
  console.log(`ui/index.html: ${(html.length / 1024).toFixed(1)} kB`);
}
