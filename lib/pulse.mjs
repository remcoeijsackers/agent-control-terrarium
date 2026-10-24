// The pulse: how a workspace's recent activity becomes the five parameters of its world. Pure, so it is easy to test
// and to explain on the page.
//
//   heat   how busy the agents were (tasks created and runs finished)
//   water  how smoothly it went (few failures make calm seas)
//   life   how much was delivered (tasks done)
//   weird  how chaotic it got (failures and agents debating on the team board), plus the workspace's trippiness setting
//   species how many different kinds of work happened (more tasks, more species), 3..9

import { clamp01 } from "./genesis.mjs";

const soft = (x, at) => clamp01(Math.log1p(Math.max(0, x)) / Math.log1p(at));

/**
 * @param {{created?: number, done?: number, failed?: number, runs?: number, board?: number}} stats counts over the window
 * @param {{trippiness?: number}} [opts]
 */
export function pulseParams(stats = {}, opts = {}) {
  const created = +stats.created || 0, done = +stats.done || 0, failed = +stats.failed || 0, runs = +stats.runs || 0, board = +stats.board || 0;
  const failRate = failed / Math.max(1, done + failed);
  const heat = clamp01(0.18 + 0.82 * soft(created + runs / 2, 40));
  const water = clamp01(0.28 + 0.5 * (1 - failRate) - 0.12 * heat + 0.1 * soft(done, 30));
  const life = clamp01((0.22 + 0.78 * soft(done, 20)) * (1 - 0.45 * failRate));
  const weird = clamp01(0.12 + 0.55 * failRate + 0.3 * soft(board, 30) + clamp01(opts.trippiness ?? 0) * 0.9);
  const species = Math.max(3, Math.min(9, 3 + Math.round(Math.log2(1 + created + done))));
  return { heat, water, life, weird, species };
}

/** What each parameter means in this workspace, for the page and for describe_terrarium. */
export function explainPulse(stats = {}, days = 7) {
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const c = (k) => +stats[k] || 0;
  return {
    heat: `${s(c("created"), "task", "tasks")} created and ${s(c("runs"), "run", "runs")} finished in ${days} days`,
    water: c("failed") ? `${s(c("failed"), "failure", "failures")} stirred the seas` : "no failures, so the seas are calm",
    life: `${s(c("done"), "task", "tasks")} delivered`,
    weird: `${s(c("failed"), "failure", "failures")} and ${s(c("board"), "board message", "board messages")}`,
    species: "more kinds of work, more species",
  };
}
