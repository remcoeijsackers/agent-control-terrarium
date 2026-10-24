// The plugin entry against a real SQLite database: events in, pulse and worlds out, tools for agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin, { settingsOf, codeFrom } from "../index.mjs";
import { fakeCtx, manifest } from "./helpers.mjs";

const load = (settings) => { const f = fakeCtx(settings); plugin.onLoad(f.ctx); return f; };

test("registers exactly what the manifest declares", () => {
  const f = load();
  assert.deepEqual([...f.routes.keys()].sort(), manifest.routes.map((r) => `${r.method} ${r.path}`).sort());
  assert.deepEqual([...f.tools.keys()].sort(), manifest.tools.map((t) => t.name).sort());
  assert.deepEqual([...f.events.keys()].sort(), [...manifest.events].sort());
});

test("events become beats and spirits; finished tasks leave the world", async () => {
  const f = load();
  await f.emit("task.created", { taskId: "t1", summary: "Task AC-1 created" });
  await f.emit("task.created", { taskId: "t2", summary: "Task AC-2 created" });
  await f.emit("task.status", { taskId: "t1", data: { from: "scheduled", to: "running" } });
  await f.emit("task.status", { taskId: "t2", data: { from: "running", to: "awaiting_input" } });
  await f.emit("run.status", { taskId: "t1", data: { from: "running", to: "running" } }); // activity update, not a beat
  await f.emit("run.status", { taskId: "t1", data: { from: "running", to: "succeeded" } });
  await f.emit("board.message", { taskId: "t1", summary: "Overleg — Claude: hi" });
  await f.emit("task.created", { taskId: "t3", summary: "Task AC-3 created" }, "ws-2");

  let p = await f.routes.get("GET /pulse")({ workspaceId: "ws-1" });
  assert.deepEqual(p.stats, { created: 2, done: 0, failed: 0, runs: 1, board: 1 });
  assert.deepEqual(p.spirits.map((s) => [s.code, s.status]).sort(), [["AC-1", "running"], ["AC-2", "awaiting_input"]]);
  assert.equal(p.seed, "workspace:ws-1");

  await f.emit("task.status", { taskId: "t1", data: { from: "running", to: "done" } });
  p = await f.routes.get("GET /pulse")({ workspaceId: "ws-1" });
  assert.deepEqual(p.spirits.map((s) => s.code), ["AC-2"]);
  assert.deepEqual(p.recent.map((s) => [s.code, s.status]), [["AC-1", "done"]]);
  assert.equal(p.stats.done, 1);

  const other = await f.routes.get("GET /pulse")({ workspaceId: "ws-2" });
  assert.equal(other.stats.created, 1);
  assert.equal(other.spirits.length, 0);
});

test("the pulse never carries task titles or prompts", async () => {
  const f = load();
  await f.emit("task.created", { taskId: "t1", summary: "Task AC-9 created", data: { title: "secret plans" } });
  await f.emit("board.message", { taskId: "t1", summary: "Overleg — Claude (note): the password is hunter2" });
  const json = JSON.stringify(await f.routes.get("GET /pulse")({ workspaceId: "ws-1" }));
  assert.ok(!json.includes("secret plans") && !json.includes("hunter2"));
});

test("worlds can be kept, listed and forgotten per workspace", async () => {
  const f = load();
  const kept = await f.routes.get("POST /worlds")({ workspaceId: "ws-1", body: { name: "  Moss\u0000Land ", seed: "moss", heat: 3, water: "0.4", life: 0.5, weird: 0.9, species: 12 } });
  assert.equal(kept.world.name, "Moss Land");
  assert.equal(kept.world.heat, 1);
  assert.equal(kept.world.water, 0.4);
  assert.equal(kept.world.species, 9);
  assert.equal(kept.world.author, "you");
  assert.equal((await f.routes.get("GET /worlds")({ workspaceId: "ws-1" })).worlds.length, 1);
  assert.equal((await f.routes.get("GET /worlds")({ workspaceId: "ws-2" })).worlds.length, 0);
  assert.deepEqual(await f.routes.get("DELETE /worlds/:id")({ workspaceId: "ws-2", params: { id: String(kept.world.id) } }), { removed: false });
  assert.deepEqual(await f.routes.get("DELETE /worlds/:id")({ workspaceId: "ws-1", params: { id: String(kept.world.id) } }), { removed: true });
});

test("agents dream worlds into the gallery and read the field guide", async () => {
  const f = load({ trippiness: "0.5" });
  const out = await f.tools.get("dream_world")({ name: "Glass Tides", heat: 0.2, water: 0.9, lore: "It rings when the moons align." }, { workspaceId: "ws-1", taskId: "t7" });
  assert.equal(out.name, "Glass Tides");
  assert.match(out.fieldGuide, /^Glass Tides\n/);
  const [w] = (await f.routes.get("GET /worlds")({ workspaceId: "ws-1" })).worlds;
  assert.equal(w.author, "agent"); assert.equal(w.taskId, "t7"); assert.equal(w.lore, "It rings when the moons align.");

  const surprise = await f.tools.get("dream_world")({}, { workspaceId: "ws-1" });
  assert.ok(surprise.name.startsWith("The "));

  const d = await f.tools.get("describe_terrarium")({}, { workspaceId: "ws-1" });
  assert.match(d.fieldGuide, /Species:/);
  assert.equal(d.keptWorlds, 2);
  assert.ok(d.shapedBy.heat.includes("7 days"));
});

test("settings are coerced and bounded", () => {
  assert.deepEqual(settingsOf({}), { trippiness: 0, days: 7, start: "pulse" });
  assert.deepEqual(settingsOf({ trippiness: "2", days: "90", start: "dream" }), { trippiness: 1, days: 30, start: "dream" });
  assert.deepEqual(settingsOf({ days: "abc", start: "x" }), { trippiness: 0, days: 7, start: "pulse" });
});

test("codeFrom reads the task code from the created summary", () => {
  assert.equal(codeFrom("Task AC-12 created"), "AC-12");
  assert.equal(codeFrom("something else"), null);
});
