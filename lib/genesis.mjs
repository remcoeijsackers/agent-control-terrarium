// Genesis: turns a seed and five parameters into a world, its flora, its species and their food web. Pure and seeded,
// so the page (which gets this file inlined by scripts/build.mjs) and the agent tools in index.mjs dream up exactly the
// same world from the same input. No DOM, no Node APIs.

export const PARAMS = ["heat", "water", "life", "weird"];
export const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(+x) ? +x : 0.5));

/** FNV-1a: a string to an unsigned 32-bit seed. */
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** A small seeded random source (mulberry32) with the helpers the generator needs. */
export function rng(seed) {
  let a = (typeof seed === "number" ? seed : hashString(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle: (arr) => { const out = [...arr]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; },
  };
  return r;
}

// ---------- names ----------
const ONSET = ["gl", "v", "th", "z", "m", "qu", "br", "s", "x", "l", "n", "k", "dr", "fl", "sh", "pl", "w", "y", "r", "bl", "sn", "gr", "ph", "t", "ch", "wh"];
const NUCLEUS = ["a", "o", "u", "ee", "i", "oo", "ae", "y", "ou", "ia", "e", "ui", "au"];
const CODA = ["mp", "rk", "ss", "n", "x", "l", "th", "sh", "ng", "b", "zz", "r", "m", "", "", "", "sk", "nd", "p"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function makeName(r, min = 2, max = 3) {
  const n = r.int(min, max);
  let s = "";
  for (let i = 0; i < n; i++) s += r.pick(ONSET) + r.pick(NUCLEUS) + (i === n - 1 || r.chance(0.35) ? r.pick(CODA) : "");
  return cap(s.length > 13 ? s.slice(0, 13) : s);
}

// ---------- world ----------
const HEAT_WORDS = [[0.2, ["Frostbitten", "Glacial", "Shivering", "Rime-Laced"]], [0.42, ["Misty", "Cool", "Pale", "Whispering"]], [0.62, ["Mild", "Verdant", "Gentle", "Blooming"]], [0.82, ["Sultry", "Amber", "Sunbaked", "Humming"]], [1.01, ["Scorched", "Ember", "Molten", "Blazing"]]];
const WEIRD_WORDS = ["Melting", "Fractal", "Velvet", "Dreaming", "Iridescent", "Prismatic", "Breathing", "Kaleidoscopic", "Liquid", "Ultraviolet"];
const WATER_PLACES = [[0.18, ["Dunes", "Salt Flats", "Mesas", "Badlands"]], [0.38, ["Steppes", "Highlands", "Canyons", "Plateaus"]], [0.58, ["Valleys", "Marshes", "Lowlands", "Fjords"]], [0.78, ["Archipelago", "Shallows", "Lagoons", "Isles"]], [1.01, ["Abyss", "Deep", "Tides", "Endless Sea"]]];
const band = (table, x) => table.find(([lim]) => x < lim)[1];

/**
 * Body plans and where they can live. `trophic` is filled in later: 1 eats flora or light, 2 hunts level 1, 3 hunts level 2.
 * Each plan has a drawing routine in the page (ui-src/app.js).
 */
export const PLANS = {
  gloop: { habitats: ["land", "water"], label: "gloop", speed: 0.06 },
  serpent: { habitats: ["land", "water"], label: "serpent", speed: 0.09 },
  jelly: { habitats: ["water", "air"], label: "drifter", speed: 0.045 },
  strider: { habitats: ["land"], label: "strider", speed: 0.08 },
  flutter: { habitats: ["air"], label: "flutterling", speed: 0.11 },
  urchin: { habitats: ["land", "water"], label: "urchin", speed: 0.05 },
};
const GRAZER_TITLES = ["the velvet grazer", "nibbler of {flora}", "the slow muncher", "who hums while eating", "keeper of {flora}", "the gentle cud-chewer", "of the soft mouths"];
const DRIFTER_TITLES = ["the light-eater", "who drinks the sun", "the glowing drifter", "that feeds on starlight", "the sunbather"];
const FILTER_TITLES = ["the patient sifter", "who drinks the tides", "of the warm currents", "the bubble-mouth", "the plankton-sieve"];
const HUNTER_TITLES = ["the patient stalker", "who hunts {prey}", "the quick jaws", "the shimmer-fanged", "terror of {prey}", "the soft-footed hunter"];
const APEX_TITLES = ["the great devourer", "sovereign of the {place}", "the many-eyed", "the old hunger", "dread of {prey}", "the last mouth"];
const FLORA = {
  glowcap: { name: "glowcaps", where: "land", heat: [0.15, 0.75] },
  spiralfern: { name: "spiral ferns", where: "land", heat: [0.3, 0.9] },
  crystal: { name: "frost crystals", where: "land", heat: [0, 0.38] },
  bulbtree: { name: "bulb trees", where: "land", heat: [0.4, 1] },
  spinebloom: { name: "spineblooms", where: "land", heat: [0.62, 1] },
  kelp: { name: "lantern kelp", where: "water", heat: [0, 1] },
};

/** Cosine palette (Inigo Quilez): colour(t) = a + b * cos(2π (c t + d)). Hot worlds lean warm, cold ones cool. */
function makePalette(r, heat, weird) {
  const warm = heat - 0.5;
  const a = [0.5 + 0.08 * warm, 0.5, 0.5 - 0.08 * warm];
  const b = [0.5, 0.5, 0.5].map((v) => v * (0.55 + 0.45 * weird));
  const c = [r.range(0.6, 1.2), r.range(0.6, 1.2), r.range(0.6, 1.2)].map((v) => v * (0.6 + 0.8 * weird));
  const d = [r.next(), r.next(), r.next()].map((v, i) => v * 0.6 + [0.0, 0.33, 0.67][i] * 0.4 + (i === 0 ? -0.15 * warm : 0));
  return { a, b, c, d };
}

const wrapHue = (h) => ((h % 360) + 360) % 360;

/**
 * Makes a world. Every parameter is 0..1 except `species` (3..9). Same input, same world.
 * @param {{seed?: string, heat?: number, water?: number, life?: number, weird?: number, species?: number}} input
 */
export function makeWorld(input = {}) {
  const seed = String(input.seed ?? "terrarium").slice(0, 80) || "terrarium";
  const heat = clamp01(input.heat ?? 0.5), water = clamp01(input.water ?? 0.5), life = clamp01(input.life ?? 0.6), weird = clamp01(input.weird ?? 0.4);
  const count = Math.max(3, Math.min(9, Math.round(Number(input.species) || 5)));
  const r = rng(`${seed}|world`);

  // Name of the world. The proper name only depends on the seed, so a world keeps its name while its parameters drift.
  const proper = makeName(rng(`${seed}|name`), 2, 3);
  const adj = weird > 0.66 ? r.pick(WEIRD_WORDS) : r.pick(band(HEAT_WORDS, heat));
  const place = r.pick(band(WATER_PLACES, water));
  const name = `The ${adj} ${place} of ${proper}`;

  // Flora: two or three kinds that fit the climate, plus kelp when there is enough sea.
  const fits = Object.entries(FLORA).filter(([k, f]) => f.where === "land" && heat >= f.heat[0] && heat <= f.heat[1]).map(([k]) => k);
  const landKinds = r.shuffle(fits.length ? fits : ["glowcap"]).slice(0, r.int(2, 3));
  const floraKinds = water > 0.2 ? [...landKinds, "kelp"] : landKinds;
  const baseHue = wrapHue(200 - heat * 190 + r.range(-25, 25));
  const flora = floraKinds.map((kind, i) => ({ kind, name: FLORA[kind].name, where: FLORA[kind].where, hue: wrapHue(baseHue + 90 + i * (50 + 120 * weird) + r.range(-20, 20)) }));

  // Trophic levels: about half eat flora or light, a third hunt them, the rest hunt the hunters.
  const apex = count >= 5 ? (count >= 8 ? 2 : 1) : 0;
  const hunters = Math.max(1, Math.round((count - apex) * 0.38));
  const levels = [...Array(count - hunters - apex).fill(1), ...Array(hunters).fill(2), ...Array(apex).fill(3)];
  const usable = (habitats) => habitats.filter((h) => (h !== "water" || water > 0.12) && (h !== "land" || water < 0.92));
  const names = new Set();
  const species = levels.map((trophic, i) => {
    const sr = rng(`${seed}|species|${i}`);
    let plan, habitat;
    for (let tries = 0; tries < 12; tries++) {
      plan = sr.pick(Object.keys(PLANS));
      const hs = usable(PLANS[plan].habitats);
      if (hs.length) { habitat = sr.pick(hs); break; }
    }
    if (!habitat) { plan = "flutter"; habitat = "air"; }
    const syll = sr.chance(0.2) ? 3 : 2;
    let nm = makeName(sr, syll, syll);
    while (names.has(nm)) nm = makeName(sr, 2, 2);
    names.add(nm);
    const diet = trophic > 1 ? "meat" : habitat === "air" || plan === "jelly" ? "light" : habitat === "water" && sr.chance(0.4) ? "filter" : "flora";
    const size = (0.0075 + sr.range(0, 0.005)) * (1 + (trophic - 1) * 0.4);
    return {
      id: i, name: nm, plan, habitat, diet, trophic,
      hue: wrapHue(baseHue + i * (360 / count) * (0.35 + 0.65 * weird) + sr.range(-30, 30) + (trophic - 1) * 25),
      sat: 60 + sr.range(0, 30), size,
      speed: PLANS[plan].speed * sr.range(0.8, 1.25) * (trophic > 1 ? 1.15 : 1),
      eyes: weird > 0.55 ? sr.int(1, 5) : sr.int(1, 2),
      limbs: sr.int(2, 4),
      social: trophic === 1 && sr.chance(0.6),
      glow: sr.range(0.3, 1),
      lifespan: sr.range(55, 110) * (trophic > 1 ? 1.3 : 1),
      eats: [], eatenBy: [], title: "",
    };
  });

  // Where there is real land, at least one grazer lives on it (that is where most flora grows).
  if (water < 0.75 && !species.some((s) => s.trophic === 1 && s.habitat === "land")) {
    const g = species.find((s) => s.trophic === 1 && PLANS[s.plan].habitats.includes("land")) ?? species.find((s) => s.trophic === 1);
    if (g) { if (!PLANS[g.plan].habitats.includes("land")) g.plan = "strider"; g.habitat = "land"; g.diet = "flora"; }
  }

  // Food web: every hunter gets prey one level down that shares a habitat (air hunters swoop on anything).
  for (const s of species.filter((x) => x.trophic > 1)) {
    const lower = species.filter((p) => p.trophic === s.trophic - 1);
    const ok = lower.filter((p) => s.habitat === "air" || p.habitat === s.habitat || (p.habitat === "air" && s.plan === "strider"));
    let prey = ok.length ? rng(`${seed}|web|${s.id}`).shuffle(ok).slice(0, Math.min(ok.length, 1 + (s.id % 3))) : [];
    if (!prey.length && lower.length) { prey = [lower[s.id % lower.length]]; s.habitat = prey[0].habitat === "air" ? "air" : prey[0].habitat; if (s.habitat === "air") s.plan = "flutter"; else if (s.plan === "flutter" || (s.plan === "strider" && s.habitat === "water")) s.plan = "serpent"; }
    s.eats = prey.map((p) => p.id);
    for (const p of prey) p.eatenBy.push(s.id);
  }
  const floraOf = (s) => flora.filter((f) => (f.where === "water") === (s.habitat === "water"));
  for (const s of species) {
    if (s.diet === "flora" && !floraOf(s).length) s.diet = s.habitat === "water" ? "filter" : "light";
    const tr = rng(`${seed}|title|${s.id}`);
    const prey = species[s.eats[0]]?.name ?? "the small ones";
    const fl = (floraOf(s)[0] ?? flora[0])?.name ?? "moss";
    const pool = s.trophic === 3 ? APEX_TITLES : s.trophic === 2 ? HUNTER_TITLES : s.diet === "light" ? DRIFTER_TITLES : s.diet === "filter" ? FILTER_TITLES : GRAZER_TITLES;
    s.title = tr.pick(pool).replace("{prey}", prey).replace("{flora}", fl).replace("{place}", place.toLowerCase());
    if (s.diet === "flora") s.floraKinds = floraOf(s).map((f) => f.kind);
  }

  return { seed, name, proper, params: { heat, water, life, weird, species: count }, palette: makePalette(r, heat, weird), flora, species };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const describeHeat = (h) => (h < 0.2 ? "frozen" : h < 0.42 ? "cool" : h < 0.62 ? "temperate" : h < 0.82 ? "warm" : "scorching");
const describeWater = (w) => (w < 0.18 ? "almost waterless" : w < 0.38 ? "dry" : w < 0.58 ? "half land, half sea" : w < 0.78 ? "mostly sea" : "an ocean world");
const describeWeird = (w) => (w < 0.25 ? "sober and natural" : w < 0.5 ? "slightly uncanny" : w < 0.75 ? "openly psychedelic" : "melting at the edges");

/** A short field guide to a world, for agents and for the page's bestiary. */
export function describeWorld(world) {
  const p = world.params;
  const lines = [
    `${world.name}`,
    `A ${describeHeat(p.heat)} world, ${describeWater(p.water)}. Life is ${p.life < 0.3 ? "sparse" : p.life < 0.65 ? "lively" : "teeming"}, and the place feels ${describeWeird(p.weird)}.`,
    `Heat ${pct(p.heat)} · water ${pct(p.water)} · life ${pct(p.life)} · weirdness ${pct(p.weird)} · seed "${world.seed}".`,
    `Flora: ${world.flora.map((f) => f.name).join(", ")}.`,
    "Species:",
  ];
  for (const s of world.species) {
    const diet = s.diet === "meat" ? `hunts ${s.eats.map((i) => world.species[i].name).join(" and ")}` : s.diet === "light" ? "lives on light" : s.diet === "filter" ? "filters the water" : `grazes on ${(s.floraKinds ?? []).map((k) => world.flora.find((f) => f.kind === k)?.name).filter(Boolean).join(" and ") || "whatever grows"}`;
    const foes = s.eatenBy.length ? `; hunted by ${s.eatenBy.map((i) => world.species[i].name).join(" and ")}` : "";
    lines.push(`- ${s.name}, ${s.title}: ${s.habitat === "air" ? "an" : "a"} ${s.habitat} ${PLANS[s.plan].label} with ${s.eyes} eye${s.eyes > 1 ? "s" : ""}; ${diet}${foes}.`);
  }
  return lines.join("\n");
}
