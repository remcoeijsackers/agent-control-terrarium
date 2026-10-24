import { test } from "node:test";
import assert from "node:assert/strict";
import { pulseParams, explainPulse } from "../lib/pulse.mjs";

const inRange = (p) => { for (const k of ["heat", "water", "life", "weird"]) assert.ok(p[k] >= 0 && p[k] <= 1, `${k}=${p[k]}`); assert.ok(p.species >= 3 && p.species <= 9); };

test("a quiet workspace is a cool, calm, sparse world", () => {
  const p = pulseParams({});
  inRange(p);
  assert.ok(p.heat < 0.3 && p.life < 0.3 && p.weird < 0.2);
  assert.equal(p.species, 3);
});

test("busy agents heat the world, deliveries bring life, failures and debates make it weird", () => {
  const quiet = pulseParams({ created: 2, done: 1 });
  const busy = pulseParams({ created: 40, runs: 60, done: 1 });
  const fruitful = pulseParams({ created: 2, done: 25 });
  const chaos = pulseParams({ created: 10, done: 2, failed: 8, board: 40 });
  assert.ok(busy.heat > quiet.heat + 0.4);
  assert.ok(fruitful.life > quiet.life + 0.3);
  assert.ok(chaos.weird > quiet.weird + 0.4);
  assert.ok(chaos.water < fruitful.water);
  assert.ok(busy.species > quiet.species);
  for (const p of [quiet, busy, fruitful, chaos, pulseParams({ created: 1e6, done: 1e6, failed: 1e6, runs: 1e6, board: 1e6 })]) inRange(p);
});

test("trippiness adds weirdness on top", () => {
  assert.ok(pulseParams({}, { trippiness: 1 }).weird > 0.9);
  assert.equal(pulseParams({}, { trippiness: 5 }).weird, pulseParams({}, { trippiness: 1 }).weird);
});

test("the explanation counts in plain words", () => {
  const e = explainPulse({ created: 1, runs: 3, done: 2, failed: 0, board: 1 }, 7);
  assert.equal(e.heat, "1 task created and 3 runs finished in 7 days");
  assert.equal(e.water, "no failures, so the seas are calm");
  assert.equal(e.weird, "0 failures and 1 board message");
});
