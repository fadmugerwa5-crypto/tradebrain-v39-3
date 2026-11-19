import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tick } from "./bounce.ts";
import { assessCandle, buildCandles, CANDLE_DEFAULTS as C, instability, simulateCandle, zigzag } from "./candle.ts";

const T0 = 1_700_000_040_000; // a minute boundary
const mk = (prices: number[], start = T0): Tick[] => prices.map((price, i) => ({ at: start + i * 1000, price }));
let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test("candles are aligned to the clock", () => {
  const c = buildCandles(mk(Array.from({ length: 150 }, (_, i) => 100 + i)), 60);
  assert.equal(c.length, 3);
  assert.equal(c[0]!.n, 60);
  assert.equal(c[1]!.h, 100 + 119);
  assert.equal(c[1]!.l, 100 + 60);
});

test("zigzag counts reversals", () => {
  assert.equal(zigzag([0, 10, 0, 10, 0, 10], 5), 4);
  assert.equal(zigzag([0, 1, 2, 3, 4, 5], 2), 0);
});

// one 60s candle: low 100 at start, rise to 120 (the high), pullback to 104 (=20 of 100 below... range 20 => pos 20)
const rise = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);

/** ten closed candles that swing 100..120 so "typical range" is 20 */
function buildHistory(n: number): Tick[] {
  const out: Tick[] = [];
  for (let c = 0; c < n; c++) {
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) prices.push(110 + 10 * Math.sin(i / 4 + c) + (rnd() - 0.5));
    out.push(...mk(prices, T0 + c * 60_000));
  }
  return out;
}

test("BUY entry at ~80 of the live candle, then simulate a win", () => {
  const hist = buildHistory(8);
  const start = T0 + 8 * 60_000;
  // live candle: low 100, high 120, pullback to 104 would be pos 20; use pullback to 116 (pos 80) then tick up
  const live = [100, ...rise(18, 100, 120), ...rise(5, 120, 115), 115.3];
  const cfg = { ...C, mode: "pullback" as const, timeframe: 60, minInstability: 0 };
  const a = assessCandle("W", [...hist, ...mk(live, start)], cfg);
  assert.equal(a.side, "BUY");
  assert.equal(a.signal, "entry");
  assert.ok(Math.abs(a.pos - 76.5) < 3, `pos ${a.pos}`);
  // simulation of the same candle continuing up hits the target
  const full = mk([...live, ...rise(6, 115.3, 119.5)], start);
  const r = simulateCandle(full, { ...cfg, closeBufferSec: 0 }, 5, start + 60_000);
  assert.equal(r?.outcome, "win");
  // continuing down hits the stop
  const bad = mk([...live, ...rise(10, 115.3, 108)], start);
  assert.equal(simulateCandle(bad, { ...cfg, closeBufferSec: 0 }, 5, start + 60_000)?.outcome, "loss");
});

test("SELL is the mirror image", () => {
  const hist = buildHistory(8);
  const start = T0 + 8 * 60_000;
  const live = [120, ...rise(18, 120, 100), ...rise(5, 100, 105), 104.7];
  const a = assessCandle("S", [...hist, ...mk(live, start)], { ...C, mode: "pullback" as const, timeframe: 60, minInstability: 0 });
  assert.equal(a.side, "SELL");
  assert.equal(a.signal, "entry");
});

test("no entry when the candle has barely moved or is about to close", () => {
  const hist = buildHistory(8);
  const start = T0 + 8 * 60_000;
  const tiny = [110, 110.1, 110.2, 110.1, 110.0, 110.1, 110.05];
  const a = assessCandle("T", [...hist, ...mk(tiny, start)], { ...C, mode: "pullback" as const, timeframe: 60, minInstability: 0 });
  assert.notEqual(a.signal, "entry");
  // same shape as the entry test, but the candle has only ~6 seconds left
  const late = [100, ...rise(18, 100, 120), ...rise(5, 120, 115), 115.3];
  const b = assessCandle("L", [...hist, ...mk(late, start + 30_000)], { ...C, mode: "pullback" as const, timeframe: 60, minInstability: 0 });
  assert.notEqual(b.signal, "entry");
});

test("choppy candles score higher than trending ones", () => {
  const choppy = buildCandles(buildHistory(8), 60);
  const trend: Tick[] = mk(Array.from({ length: 480 }, (_, i) => 100 + i * 0.3 + (rnd() - 0.5) * 0.2));
  assert.ok(instability(choppy).score > instability(buildCandles(trend, 60)).score + 15);
});
