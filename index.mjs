// Terrarium: a living world that grows from a workspace's activity. The plugin only keeps a small log of that activity
// (task ids, codes and statuses; never titles or prompts) and the worlds people and agents keep. Everything visual
// happens in ui/index.html, which asks GET /pulse through the dashboard's bridge. See README.md.
import { makeWorld, describeWorld, clamp01 } from "./lib/genesis.mjs";
import { pulseParams, explainPulse } from "./lib/pulse.mjs";

/** Task statuses that show up as spirits in the world. */
export const SPIRIT_STATUSES = ["running", "awaiting_input", "review", "merging"];
const FINISHED = ["done", "failed", "cancelled"];
const TERMINAL_RUNS = ["succeeded", "failed", "interrupted"];
const KEEP_DAYS = 31;

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const daysAgo = (d) => iso(Date.now() - d * 864e5);
const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max) : "");
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

/** Settings as stored by Agent Control (numbers may arrive as strings) to what the plugin uses. */
export function settingsOf(raw = {}) {
  const days = Math.round(num(raw.days) ?? 7);
  return {
    trippiness: clamp01(num(raw.trippiness) ?? 0),
    days: Number.isFinite(days) ? Math.max(1, Math.min(30, days)) : 7,
    start: raw.start === "dream" ? "dream" : "pulse",
  };
}

/** "Task AC-12 created" → "AC-12". */
export const codeFrom = (summary) => /^Task (\S+) created/.exec(String(summary ?? ""))?.[1] ?? null;

/** The plugin's logic on top of ctx.db, so tests can run it against a plain SQLite database. */
export function createTerrarium(ctx) {
  const db = ctx.db;
  let sincePrune = 0;

  const upsertTask = (ws, taskId, status, code = null) => {
    const at = iso();
    db.run(`INSERT INTO {{tasks}} (workspace_id, task_id, code, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, task_id) DO UPDATE SET status = excluded.status, code = COALESCE(excluded.code, code), updated_at = excluded.updated_at`,
      ws, taskId, code, status, at, at);
  };
  const beat = (ws, kind, taskId) => {
    db.run("INSERT INTO {{beats}} (workspace_id, kind, task_id, at) VALUES (?, ?, ?, ?)", ws, kind, taskId ?? null, iso());
    if (++sincePrune >= 200) prune();
  };
  const prune = () => {
    sincePrune = 0;
    const cut = daysAgo(KEEP_DAYS);
    db.run("DELETE FROM {{beats}} WHERE at < ?", cut);
    db.run(`DELETE FROM {{tasks}} WHERE updated_at < ? AND status IN (${FINISHED.map(() => "?").join(", ")})`, cut, ...FINISHED);
  };

  function onEvent(e, { workspaceId: ws }) {
    const to = e?.data?.to, from = e?.data?.from;
    switch (e?.kind) {
      case "task.created":
        upsertTask(ws, e.taskId, "new", codeFrom(e.summary));
        beat(ws, "created", e.taskId);
        break;
      case "task.status":
        if (typeof to !== "string") return;
        upsertTask(ws, e.taskId, to);
        if (to === "done" || to === "failed") beat(ws, to, e.taskId);
        break;
      case "run.status":
        if (from !== to && TERMINAL_RUNS.includes(to)) beat(ws, "run", e.taskId);
        break;
      case "board.message":
        beat(ws, "board", e.taskId);
        break;
    }
  }

  function worlds(ws) {
    return db.all("SELECT id, name, seed, heat, water, life, weird, species, lore, author, task_id AS taskId, created_at AS createdAt FROM {{worlds}} WHERE workspace_id = ? ORDER BY id DESC LIMIT 60", ws);
  }

  function pulse(ws, settings) {
    const days = settings.days;
    const stats = { created: 0, done: 0, failed: 0, runs: 0, board: 0 };
    for (const r of db.all("SELECT kind, COUNT(*) AS n FROM {{beats}} WHERE workspace_id = ? AND at >= ? GROUP BY kind", ws, daysAgo(days))) {
      const key = r.kind === "run" ? "runs" : r.kind;
      if (key in stats) stats[key] = Number(r.n);
    }
    const marks = (list) => list.map(() => "?").join(", ");
    const spirits = db.all(`SELECT task_id AS id, code, status, updated_at AS since FROM {{tasks}} WHERE workspace_id = ? AND status IN (${marks(SPIRIT_STATUSES)}) ORDER BY updated_at DESC LIMIT 40`, ws, ...SPIRIT_STATUSES);
    const recent = db.all(`SELECT task_id AS id, code, status, updated_at AS at FROM {{tasks}} WHERE workspace_id = ? AND status IN (${marks(FINISHED)}) AND updated_at >= ? ORDER BY updated_at DESC LIMIT 40`, ws, ...FINISHED, iso(Date.now() - 6 * 3600e3));
    return {
      workspaceId: ws, seed: `workspace:${ws}`, days, stats,
      params: pulseParams(stats, settings), explain: explainPulse(stats, days),
      spirits, recent, settings, worlds: worlds(ws), at: iso(),
    };
  }

  /** Keeps a world in the workspace's gallery. `input` comes from the page or an agent, so everything is checked. */
  function keep(ws, input = {}, author = "you", taskId = null) {
    const rand = () => Math.round(Math.random() * 100) / 100;
    const seed = text(input.seed, 80) || `dream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const p = {
      heat: clamp01(num(input.heat) ?? rand()), water: clamp01(num(input.water) ?? rand()),
      life: clamp01(num(input.life) ?? 0.35 + rand() * 0.6), weird: clamp01(num(input.weird) ?? rand()),
      species: Math.max(3, Math.min(9, Math.round(num(input.species) ?? 4 + Math.random() * 4))),
    };
    const world = makeWorld({ seed, ...p });
    const name = text(input.name, 80) || world.name;
    const lore = text(input.lore, 600) || null;
    const id = db.run(`INSERT INTO {{worlds}} (workspace_id, name, seed, heat, water, life, weird, species, lore, author, task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ws, name, seed, p.heat, p.water, p.life, p.weird, p.species, lore, author, taskId, iso()).lastInsertRowid;
    return { id, name, seed, ...p, lore, author, taskId, world };
  }

  const remove = (ws, id) => ({ removed: db.run("DELETE FROM {{worlds}} WHERE workspace_id = ? AND id = ?", ws, Number(id)).changes > 0 });

  return { onEvent, pulse, worlds, keep, remove, prune };
}

export default {
  onLoad(ctx) {
    const t = createTerrarium(ctx);
    const settings = (ws) => settingsOf(ctx.settings.get(ws));
    t.prune();

    for (const kind of ["task.created", "task.status", "run.status", "board.message"]) ctx.events.on(kind, t.onEvent);

    ctx.routes.handle("GET", "/pulse", (req) => t.pulse(req.workspaceId, settings(req.workspaceId)));
    ctx.routes.handle("GET", "/worlds", (req) => ({ worlds: t.worlds(req.workspaceId) }));
    ctx.routes.handle("POST", "/worlds", (req) => {
      const { world, ...kept } = t.keep(req.workspaceId, req.body ?? {}, "you");
      return { world: kept };
    });
    ctx.routes.handle("DELETE", "/worlds/:id", (req) => t.remove(req.workspaceId, req.params.id));

    ctx.tools.register("dream_world", (args, info) => {
      const { world, ...kept } = t.keep(info.workspaceId, args ?? {}, "agent", info.taskId ?? null);
      ctx.log.info(`An agent dreamed "${kept.name}"`);
      return { id: kept.id, name: kept.name, seed: kept.seed, fieldGuide: describeWorld({ ...world, name: kept.name }), lore: kept.lore, seeIt: "Plugins → Terrarium → Worlds" };
    });
    ctx.tools.register("describe_terrarium", (_args, info) => {
      const p = t.pulse(info.workspaceId, settings(info.workspaceId));
      const world = makeWorld({ seed: p.seed, ...p.params });
      const spirits = Object.fromEntries(SPIRIT_STATUSES.map((s) => [s, p.spirits.filter((x) => x.status === s).length]));
      return { fieldGuide: describeWorld(world), shapedBy: p.explain, window: `${p.days} days`, spirits, keptWorlds: p.worlds.length };
    });
    ctx.log.info("Terrarium is growing");
  },
};
