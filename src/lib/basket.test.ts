import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tick } from "./bounce.ts";
import { assessCandle, CANDLE_DEFAULTS as C, simulateCandle } from "./candle.ts";
import { nextScale, planBasket } from "./basket.ts";

const T0 = 1_700_000_040_000;
const mk = (prices: number[], start = T0): Tick[] => prices.map((price, i) => ({ at: start + i * 1000, price }));
const ramp = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
let seed = 5;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function history(n: number): Tick[] {
  const out: Tick[] = [];
  for (let c = 0; c < n; c++) out.push(...mk(Array.from({ length: 60 }, (_, i) => 110 + 10 * Math.sin(i / 4 + c) + (rnd() - 0.5)), T0 + c * 60_000));
  return out;
}
const cfg = { ...C, mode: "basket" as const, timeframe: 60, minInstability: 0 };
const start = T0 + 8 * 60_000;

test("a dumping candle that reaches its low and ticks back triggers a BUY basket", () => {
  // opens 112, spikes to 125, dumps to 100, ticks up
  const live = [112, ...ramp(8, 112, 125), ...ramp(20, 125, 100), 100.4];
  const a = assessCandle("B", [...history(8), ...mk(live, start)], cfg);
  assert.equal(a.side, "BUY");
  assert.equal(a.signal, "entry");
});

test("a pumping candle that reaches its high and ticks back triggers a SELL basket", () => {
  const live = [112, ...ramp(8, 112, 100), ...ramp(20, 100, 125), 124.6];
  const a = assessCandle("B2", [...history(8), ...mk(live, start)], cfg);
  assert.equal(a.side, "SELL");
  assert.equal(a.signal, "entry");
});

test("armed (not entry) while the dump is still falling", () => {
  const live = [112, ...ramp(8, 112, 125), ...ramp(20, 125, 100)];
  const a = assessCandle("B3", [...history(8), ...mk(live, start)], cfg);
  assert.notEqual(a.signal, "entry");
});

test("no basket on a quiet candle", () => {
  const live = [110, 110.2, 110.1, 110.3, 110.0, 110.1, 110.2, 110.1];
  const a = assessCandle("B4", [...history(8), ...mk(live, start)], cfg);
  assert.notEqual(a.signal, "entry");
});

test("replay: bounce after the dump wins, further fall loses", () => {
  const base = [125, ...ramp(28, 125, 100), 100.4];
  const win = mk([...base, ...ramp(8, 100.4, 106)], start);
  assert.equal(simulateCandle(win, cfg, 5, start + 60_000)?.outcome, "win");
  const loss = mk([...base, ...ramp(10, 100.4, 90)], start);
  assert.equal(simulateCandle(loss, cfg, 5, start + 60_000)?.outcome, "loss");
});

test("basket sizing: legs share the position, target and loss caps respected", () => {
  const p = planBasket({ price: 3880, range: 20, bounceFrac: 0.15, stopFrac: 0.25, legs: 5, targetUsd: 1.5, maxLossUsd: 3, minNetUsd: 0.5, costFrac: 0.0003, options: [100, 200, 300, 400, 500] });
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.legs.length, 5);
  assert.ok(p.targetNet >= 0.5 && p.targetNet <= 1.6, `target ${p.targetNet}`); // the $3 loss cap limits how large the target can be
  assert.ok(p.maxLoss <= 3.75);
  assert.ok(p.legs.every((l) => l.stake >= 1 && l.stake >= l.stopLoss * 1.05));
});

test("basket refused when the bounce cannot beat Deriv's cost", () => {
  const p = planBasket({ price: 3880, range: 0.5, bounceFrac: 0.15, stopFrac: 0.25, legs: 5, targetUsd: 1.5, maxLossUsd: 3, minNetUsd: 0.5, costFrac: 0.0003, options: [100, 200] });
  assert.equal(p.ok, false);
});

test("size scaling: +25% per win up to the cap, reset on a loss", () => {
  assert.equal(nextScale(1, true, 0.25, 4), 1.25);
  assert.equal(nextScale(3.9, true, 0.25, 4), 4);
  assert.equal(nextScale(2.5, false, 0.25, 4), 1);
});
