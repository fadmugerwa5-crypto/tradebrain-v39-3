import { test } from "node:test";
import assert from "node:assert/strict";
import { BOUNCE_DEFAULTS as C, assessBounce, breakEvenRate, marketBlocked, pickMultiplier, planTrade, position, replayCycles, summarizeTrades, type Tick } from "./bounce.ts";

const mk = (prices: number[]): Tick[] => prices.map((price, i) => ({ at: 1_000_000 + i * 1000, price }));
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

/** price swings between ~72 and 100 of its range (one deep dip in each half so the range is anchored) */
function oscillating(n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let pos = 86 + 14 * Math.sin(i / 9) + (rnd() - 0.5) * 1.2;
    if (i === 100 || i === 500) pos = 0;
    out.push(1000 + pos * 0.5);
  }
  return out;
}

test("position maps price into 0..100", () => {
  assert.equal(position(5, 0, 10), 50);
  assert.equal(position(10, 0, 10), 100);
  assert.equal(position(1, 5, 5), 50);
});

test("break-even hit rate for 80/90/65 is 60%", () => {
  assert.ok(Math.abs(breakEvenRate(C) - 0.6) < 1e-9);
});

test("replay counts a win, a loss and a timeout", () => {
  const t = (n: number) => Array.from({ length: n }, (_, i) => i * 1000);
  // peak, drop to 80, recover to 91 -> win
  assert.deepEqual(replayCycles([95, 85, 79, 85, 91], t(5), C), { events: 1, wins: 1, losses: 0, timeouts: 0 });
  // peak, drop to 80, fall to 60 -> loss
  assert.deepEqual(replayCycles([95, 85, 79, 70, 60], t(5), C), { events: 1, wins: 0, losses: 1, timeouts: 0 });
  // peak, drop to 80, hover too long -> timeout
  const slow = [95, 79, 78, 79];
  assert.equal(replayCycles(slow, [0, 1000, 50_000, 100_000], C).timeouts, 1);
  // falls straight through without offering an entry: no event
  assert.equal(replayCycles([95, 60, 50], t(3), C).events, 0);
});

test("a clean oscillating market qualifies and reports a hit rate", () => {
  const a = assessBounce(mk(oscillating(600)), { ...C, requireProof: true });
  assert.ok(a.events >= C.minEvents, `events ${a.events}`);
  assert.ok(a.hitRate >= 0.6, `hit rate ${a.hitRate}`);
  assert.equal(a.ok, true);
});

test("a trending market is rejected", () => {
  const prices = Array.from({ length: 600 }, (_, i) => 100 + i * 0.05 + (rnd() - 0.5) * 0.2);
  const a = assessBounce(mk(prices), { ...C, requireProof: true });
  assert.equal(a.ok, false);
  assert.match(a.reason, /Trending|cycles/);
  // relaxed mode still lets it be watched
  assert.equal(assessBounce(mk(prices)).ok, true);
});

test("too few ticks is not tradable", () => {
  const a = assessBounce(mk(oscillating(50)));
  assert.equal(a.ok, false);
  assert.equal(a.signal, "skip");
});

test("live long entry fires on the first up tick after peak then drop to entry zone", () => {
  const base = oscillating(560);
  // force a clean setup at the end: top, slide to ~79, tick up
  const lo = Math.min(...base);
  const hi = Math.max(...base);
  const at = (p: number) => lo + (p / 100) * (hi - lo);
  const setup = [96, 93, 90, 86, 82, 79, 78.5, 79.5].map(at);
  const a = assessBounce(mk([...base, at(97), ...setup]));
  assert.equal(a.ok, true);
  assert.equal(a.signal, "entry");
  assert.equal(a.side, "BUY");
  assert.ok(a.pos <= 80 && a.pos > 68, `pos ${a.pos}`);
});

test("no entry when the last tick is still falling", () => {
  const base = oscillating(560);
  const lo = Math.min(...base);
  const hi = Math.max(...base);
  const at = (p: number) => lo + (p / 100) * (hi - lo);
  const a = assessBounce(mk([...base, at(97), ...[93, 89, 85, 82, 79].map(at)]));
  assert.notEqual(a.signal, "entry");
});

test("planTrade sizes to the net target but caps the loss", () => {
  const p = planTrade({ price: 1000, lo: 990, hi: 1010, cfg: C, targetNetUsd: 1.5, maxLossUsd: 3, minNetUsd: 0.5, costFrac: 0.0002 });
  assert.ok(p);
  assert.ok(p!.stopLoss <= 3.0001, `stop loss ${p!.stopLoss}`);
  assert.ok(p!.expectedNet > 0.5);
  // tiny range cannot beat costs
  assert.equal(planTrade({ price: 1000, lo: 999.99, hi: 1000.01, cfg: C, targetNetUsd: 1.5, maxLossUsd: 3, minNetUsd: 0.5, costFrac: 0.0005 }), null);
});

test("pickMultiplier keeps the stop inside the stake and respects minimum stake", () => {
  const m = pickMultiplier([20, 50, 100, 200], 400, 2, 1);
  assert.ok(m);
  assert.ok(m!.stake >= 2.2 && m!.stake >= 1);
  assert.equal(pickMultiplier([], 100, 1), null);
  const forced = pickMultiplier([10], 5, 2, 1);
  assert.ok(forced!.stake >= 2.2);
});

test("summary and per-market blocking", () => {
  const trades = [{ symbol: "A", pnl: 1.5 }, { symbol: "A", pnl: -2 }, { symbol: "B", pnl: 1 }];
  const s = summarizeTrades(trades);
  assert.equal(s.trades, 3);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.net - 0.5) < 1e-9);
  const bad = Array.from({ length: 10 }, (_, i) => ({ symbol: "X", pnl: i < 2 ? 1 : -1 }));
  assert.equal(marketBlocked(bad, "X"), true);
  assert.equal(marketBlocked(bad, "Y"), false);
});
