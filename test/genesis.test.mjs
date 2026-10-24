import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, describeWorld, rng, hashString, PLANS } from "../lib/genesis.mjs";

test("the same seed and parameters grow the same world", () => {
  const a = makeWorld({ seed: "moss", heat: 0.3, water: 0.6, life: 0.7, weird: 0.5, species: 7 });
  const b = makeWorld({ seed: "moss", heat: 0.3, water: 0.6, life: 0.7, weird: 0.5, species: 7 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.species.map((s) => s.name), makeWorld({ seed: "lichen", species: 7 }).species.map((s) => s.name));
});

test("a world keeps its proper name and species names while its climate drifts", () => {
  const cold = makeWorld({ seed: "drift", heat: 0.1, water: 0.5, species: 6 });
  const hot = makeWorld({ seed: "drift", heat: 0.9, water: 0.5, species: 6 });
  assert.equal(cold.proper, hot.proper);
  assert.deepEqual(cold.species.map((s) => s.name), hot.species.map((s) => s.name));
});

test("every hunter has prey one level down, and every prey knows its hunter", () => {
  for (let i = 0; i < 300; i++) {
    const r = rng(i);
    const w = makeWorld({ seed: `s${i}`, heat: r.next(), water: r.next(), life: r.next(), weird: r.next(), species: r.int(3, 9) });
    assert.ok(w.species.length >= 3 && w.species.length <= 9);
    assert.ok(w.species.some((s) => s.trophic === 1), "something eats flora or light");
    for (const s of w.species) {
      assert.ok(PLANS[s.plan], `known plan ${s.plan}`);
      assert.ok(["land", "water", "air"].includes(s.habitat));
      if (s.trophic > 1) {
        assert.equal(s.diet, "meat");
        assert.ok(s.eats.length > 0, `${s.name} in ${w.seed} has prey`);
        for (const p of s.eats) { assert.equal(w.species[p].trophic, s.trophic - 1); assert.ok(w.species[p].eatenBy.includes(s.id)); }
      }
      if (s.diet === "flora") assert.ok(s.floraKinds.length > 0, `${s.name} in ${w.seed} has something to graze`);
    }
    assert.equal(new Set(w.species.map((s) => s.name)).size, w.species.length, "names are unique");
    if (w.params.water < 0.75) assert.ok(w.species.some((s) => s.habitat === "land"), `${w.seed} has land life`);
  }
});

test("out-of-range input is clamped, not trusted", () => {
  const w = makeWorld({ seed: "x".repeat(500), heat: 9, water: -3, life: "lots", weird: NaN, species: 99 });
  assert.equal(w.seed.length, 80);
  assert.deepEqual(w.params, { heat: 1, water: 0, life: 0.5, weird: 0.5, species: 9 });
});

test("the field guide names every species", () => {
  const w = makeWorld({ seed: "guide", species: 5 });
  const text = describeWorld(w);
  assert.match(text, new RegExp(w.name));
  for (const s of w.species) assert.match(text, new RegExp(s.name));
});

test("hashString and rng are stable", () => {
  assert.equal(hashString("terrarium"), hashString("terrarium"));
  assert.equal(rng("a").next(), rng("a").next());
  assert.notEqual(rng("a").next(), rng("b").next());
});
