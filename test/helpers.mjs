// A stand-in for Agent Control's plugin ctx: a real SQLite database with the plugin's migrations, {{table}} expansion
// and the same rule as Agent Control that everything registered at runtime must be declared in manifest.json.
import { DatabaseSync, constants as C } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dirname, "..");
export const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

export function fakeCtx(settings = {}) {
  const db = new DatabaseSync(":memory:");
  const prefix = `plugin_${manifest.id.replace(/-/g, "_")}__`;
  const x = (sql) => sql.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, t) => {
    if (!manifest.tables.includes(t)) throw new Error(`table ${t} is not declared`);
    return prefix + t;
  });
  // The same rule Agent Control's SQLite authorizer enforces: only the plugin's own tables and indexes, by name.
  let ddl = true;
  const own = (n) => typeof n === "string" && n.startsWith(prefix);
  const internal = (n) => ddl && (n === "sqlite_master" || n === "sqlite_sequence");
  db.setAuthorizer((action, a1, a2) => {
    switch (action) {
      case C.SQLITE_SELECT: case C.SQLITE_FUNCTION: case C.SQLITE_RECURSIVE: return C.SQLITE_OK;
      case C.SQLITE_READ: return a1 === "" || own(a1) || internal(a1) ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_INSERT: case C.SQLITE_UPDATE: case C.SQLITE_DELETE: return own(a1) || internal(a1) ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_CREATE_TABLE: return ddl && own(a1) ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_CREATE_INDEX: return ddl && own(a1) && own(a2) ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_REINDEX: return ddl && own(a1) ? C.SQLITE_OK : C.SQLITE_DENY;
      default: return C.SQLITE_DENY;
    }
  });
  for (const f of readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) db.exec(x(readFileSync(join(root, "migrations", f), "utf8")));
  ddl = false;
  const routes = new Map(), tools = new Map(), events = new Map(), logs = [];
  const plain = (r) => (r ? { ...r } : r);
  const ctx = {
    id: manifest.id, manifest,
    db: {
      run: (s, ...a) => { const r = db.prepare(x(s)).run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      all: (s, ...a) => db.prepare(x(s)).all(...a).map(plain),
      get: (s, ...a) => plain(db.prepare(x(s)).get(...a)),
    },
    routes: { handle: (method, path, h) => { if (!manifest.routes.some((r) => r.method === method && r.path === path)) throw new Error(`route ${method} ${path} not declared`); routes.set(`${method} ${path}`, h); } },
    tools: { register: (name, h) => { if (!manifest.tools.some((t) => t.name === name)) throw new Error(`tool ${name} not declared`); tools.set(name, h); } },
    events: { on: (kind, h) => { if (!manifest.events.includes(kind)) throw new Error(`event ${kind} not declared`); events.set(kind, [...(events.get(kind) ?? []), h]); } },
    settings: { get: () => settings },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  };
  const emit = async (kind, event, workspaceId = "ws-1") => { for (const h of events.get(kind) ?? []) await h({ kind, data: {}, ...event }, { workspaceId }); };
  return { ctx, db, routes, tools, events, logs, emit };
}
