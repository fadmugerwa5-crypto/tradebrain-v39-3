/**
 * Jump Scalper — live-candle pullback strategy (pure functions, no I/O).
 *
 * The LIVE candle (on a chosen timeframe) is the whole playing field:
 *   100 = the candle's highest price so far, 0 = its lowest price so far (both update on every tick).
 *   BUY : the candle is rising (its high came after its low). Price pulls back from 100 to ~80,
 *         ticks back up -> BUY, take profit near 95, stop near 62.
 *   SELL: the exact mirror (candle falling, price bounces up from the low).
 * The scanner ranks markets by how "unstable" their candles are (many swings, long wicks, no one-way trend).
 *
 * BASKET mode (default) is the "buy the dump, close the whole stack on the bounce" idea:
 *   a live candle spikes/dumps, price sits near the candle's low (BUY) or high (SELL) and ticks back ->
 *   open a stack of several entries at once, close ALL of them together as soon as the basket is in profit.
 */
import { breakEvenRate, type Assessment, type CycleStats, type Tick } from "./bounce.ts";

export type CandleConfig = {
  /** "basket": stack several entries at the extreme of a spiking candle and close them together on the bounce. "pullback": single trade, buy the dip from the candle high. */
  mode: "basket" | "pullback";
  /** basket: entries opened together */
  legs: number;
  /** basket: bounce wanted, as a share of the live candle's range */
  bounceFrac: number;
  /** basket: the idea failed when price moves this share of the candle range against the entry */
  stopFrac: number;
  /** basket: the live candle must be at least this multiple of a typical candle (a real spike) */
  spikeMult: number;
  /** basket: price must be within this many points (0-100) of the candle's extreme */
  dumpZone: number;
  /** basket: size grows by this much after every winning basket (0.25 = +25%) */
  scaleStep: number;
  /** basket: size never grows beyond this multiple of the base size */
  scaleMax: number;
  /** basket: close everything if the basket is still open after this many seconds */
  basketHoldSec: number;
  /** candle length in seconds; 0 = automatic (tests 1m and 5m per market and picks the better one) */
  timeframe: number;
  /** buy when price has pulled back to this level of the live candle (0-100) */
  entryLevel: number;
  /** take profit level */
  targetLevel: number;
  /** stop level: if price falls this far the idea failed */
  stopLevel: number;
  /** live candle must be at least this multiple of the typical recent candle range before it may trade */
  minRangeMult: number;
  /** absolute floor for the live candle range as a percent of price */
  minRangePct: number;
  /** no entries this close to the candle close, and open trades are closed this many seconds before it */
  closeBufferSec: number;
  /** trade is closed if it hasn't hit target/stop within this time */
  maxHoldSec: number;
  /** a market needs at least this instability score (0-100) to be traded */
  minInstability: number;
  /** how many recent closed candles define "typical" and the replay proof */
  historyCandles: number;
  /** strict mode: minimum finished cycles in the replay before a market may be traded */
  minEvents: number;
  minHitRate: number;
  edgeMargin: number;
  /** strict mode: trade only markets whose own candle history proves the pullback paid */
  requireProof: boolean;
};

export const CANDLE_DEFAULTS: CandleConfig = {
  mode: "basket",
  legs: 5,
  bounceFrac: 0.15,
  stopFrac: 0.25,
  spikeMult: 1,
  dumpZone: 25,
  scaleStep: 0.25,
  scaleMax: 4,
  basketHoldSec: 120,
  timeframe: 0,
  entryLevel: 80,
  targetLevel: 95,
  stopLevel: 62,
  minRangeMult: 0.6,
  minRangePct: 0.01,
  closeBufferSec: 10,
  maxHoldSec: 90,
  minInstability: 30,
  historyCandles: 20,
  minEvents: 5,
  minHitRate: 0.55,
  edgeMargin: 0.03,
  requireProof: false,
};

export const AUTO_TIMEFRAMES = [60, 300];
export const tfLabel = (s: number) => (s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${s / 60}m` : `${s}s`);

export type Candle = { t: number; o: number; h: number; l: number; c: number; n: number; ticks: Tick[] };

/** Groups ticks into candles aligned to the clock, like a chart does. */
export function buildCandles(ticks: Tick[], tf: number): Candle[] {
  const ms = tf * 1000;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const k of ticks) {
    const t = Math.floor(k.at / ms) * ms;
    if (!cur || cur.t !== t) {
      cur = { t, o: k.price, h: k.price, l: k.price, c: k.price, n: 0, ticks: [] };
      out.push(cur);
    }
    if (k.price > cur.h) cur.h = k.price;
    if (k.price < cur.l) cur.l = k.price;
    cur.c = k.price;
    cur.n++;
    cur.ticks.push(k);
  }
  return out;
}

/** Counts up/down reversals bigger than `thr`. */
export function zigzag(prices: number[], thr: number) {
  if (!(thr > 0) || !prices.length) return 0;
  let dir = 0;
  let ext = prices[0]!;
  let swings = 0;
  for (const p of prices) {
    if (dir === 0) {
      if (p >= ext + thr) {
        dir = 1;
        ext = p;
      } else if (p <= ext - thr) {
        dir = -1;
        ext = p;
      }
    } else if (dir === 1) {
      if (p > ext) ext = p;
      else if (ext - p >= thr) {
        dir = -1;
        ext = p;
        swings++;
      }
    } else if (p < ext) ext = p;
    else if (p - ext >= thr) {
      dir = 1;
      ext = p;
      swings++;
    }
  }
  return swings;
}

export function candleStats(c: Candle) {
  const range = c.h - c.l;
  if (c.n < 8 || !(range > 0)) return null;
  let path = 0;
  for (let i = 1; i < c.ticks.length; i++) path += Math.abs(c.ticks[i]!.price - c.ticks[i - 1]!.price);
  const body = Math.abs(c.c - c.o);
  return {
    range,
    chop: path > 0 ? 1 - body / path : 0,
    wick: 1 - body / range,
    swings: zigzag(c.ticks.map((k) => k.price), range * 0.15),
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** 0-100: how much the candles swing up and down instead of running one way. */
export function instability(candles: Candle[]) {
  const st = candles.map(candleStats).filter((x): x is NonNullable<ReturnType<typeof candleStats>> => !!x);
  if (!st.length) return { score: 0, chop: 0, wick: 0, swings: 0, medRange: 0 };
  const avg = (f: (x: (typeof st)[number]) => number) => st.reduce((s, x) => s + f(x), 0) / st.length;
  const chop = avg((x) => x.chop);
  const wick = avg((x) => x.wick);
  const swings = avg((x) => x.swings);
  const score = 100 * (0.4 * chop + 0.35 * Math.min(swings / 5, 1) + 0.25 * wick);
  return { score, chop, wick, swings, medRange: median(st.map((x) => x.range)) };
}

/** Running state of one candle, built tick by tick. */
type St = { n: number; hi: number; lo: number; hiIdx: number; loIdx: number; last: number; prev: number };
const newSt = (): St => ({ n: 0, hi: -Infinity, lo: Infinity, hiIdx: -1, loIdx: -1, last: NaN, prev: NaN });
function push(s: St, p: number) {
  s.prev = s.last;
  s.last = p;
  if (p >= s.hi) {
    s.hi = p;
    s.hiIdx = s.n;
  }
  if (p <= s.lo) {
    s.lo = p;
    s.loIdx = s.n;
  }
  s.n++;
}

type Ev = { side: "BUY" | "SELL" | null; sig: "entry" | "armed" | "watch"; pos: number; why: string };

/** Where is the live candle right now, and is there a pullback trade? `left` = seconds until the candle closes. */
export function evalCandle(s: St, cfg: CandleConfig, minRange: number, left: number): Ev {
  const range = s.hi - s.lo;
  const pos = range > 0 ? ((s.last - s.lo) / range) * 100 : 50;
  const wait = (why: string): Ev => ({ side: null, sig: "watch", pos, why });
  if (s.n < 5) return wait("Candle just opened");
  if (range < minRange) return wait("Waiting for this candle to move enough");
  if (s.hiIdx === s.loIdx) return wait("No clear direction yet");
  const up = s.hiIdx > s.loIdx;
  const side = up ? "BUY" : "SELL";
  const p = up ? pos : 100 - pos; // mirrored so that 100 is always "the extreme we pull back from"
  if (p <= cfg.stopLevel + 3) return wait("Candle reversed too far, waiting for the next one");
  if (p > cfg.entryLevel) return { side, sig: "armed", pos, why: `${side} armed: candle ${up ? "high" : "low"} set, waiting for the pullback to ${cfg.entryLevel}` };
  if (left < cfg.closeBufferSec + 15) return wait("Too close to the candle close");
  const back = up ? s.last > s.prev : s.last < s.prev;
  if (!back) return { side, sig: "armed", pos, why: `${side}: pullback reached the zone, waiting for the first tick back` };
  return { side, sig: "entry", pos, why: `${side} setup: pulled back to ${p.toFixed(0)}, first tick back` };
}

/**
 * Basket trigger. The live candle has spiked (range well above a typical candle) and price is sitting near its extreme:
 * near the LOW after a drop -> BUY the bounce; near the HIGH after a rise -> SELL the bounce back.
 */
export function evalDump(s: St, cfg: CandleConfig, minRange: number): Ev {
  const range = s.hi - s.lo;
  const pos = range > 0 ? ((s.last - s.lo) / range) * 100 : 50;
  const wait = (why: string): Ev => ({ side: null, sig: "watch", pos, why });
  if (s.n < 5) return wait("Candle just opened");
  if (range < minRange) return wait("Waiting for a spike (candle still small)");
  if (s.hiIdx === s.loIdx) return wait("No clear direction yet");
  const buy = s.loIdx > s.hiIdx; // the low is the latest extreme: the candle dumped
  const side = buy ? "BUY" : "SELL";
  const near = buy ? pos : 100 - pos; // 0 = sitting on the extreme
  if (near > 50) return wait(`Spike seen, ${side} when price falls toward the ${buy ? "low" : "high"}`);
  if (near > cfg.dumpZone) return { side, sig: "armed", pos, why: `${side} armed: candle ${buy ? "dumping" : "pumping"}, waiting for the ${buy ? "low" : "high"} zone` };
  const back = buy ? s.last > s.prev : s.last < s.prev;
  if (!back) return { side, sig: "armed", pos, why: `${side}: price at the ${buy ? "low" : "high"}, waiting for the first tick back` };
  return { side, sig: "entry", pos, why: `${side} basket: spike ${buy ? "dump" : "pump"} reached the extreme, first tick back` };
}

const evalFor = (s: St, cfg: CandleConfig, minRange: number, left: number): Ev => (cfg.mode === "basket" ? evalDump(s, cfg, minRange) : evalCandle(s, cfg, minRange, left));

export type SimResult = { side: "BUY" | "SELL"; outcome: "win" | "loss" | "timeout" } | null;

/** Replays one finished candle with the live rules and reports how the (single) trade would have ended. */
export function simulateCandle(ticks: Tick[], cfg: CandleConfig, minRange: number, endAt: number): SimResult {
  const st = newSt();
  let trade: { side: "BUY" | "SELL"; at: number; target: number; stop: number } | null = null;
  for (const k of ticks) {
    push(st, k.price);
    if (!trade) {
      const e = evalFor(st, cfg, minRange, (endAt - k.at) / 1000);
      if (e.sig === "entry" && e.side) {
        const r = st.hi - st.lo;
        const buy = e.side === "BUY";
        if (cfg.mode === "basket") {
          trade = { side: e.side, at: k.at, target: k.price + (buy ? 1 : -1) * cfg.bounceFrac * r, stop: k.price - (buy ? 1 : -1) * cfg.stopFrac * r };
        } else {
          trade = {
            side: e.side,
            at: k.at,
            target: st.lo + ((buy ? cfg.targetLevel : 100 - cfg.targetLevel) / 100) * r,
            stop: st.lo + ((buy ? cfg.stopLevel : 100 - cfg.stopLevel) / 100) * r,
          };
        }
      }
      continue;
    }
    const buy = trade.side === "BUY";
    if (buy ? k.price >= trade.target : k.price <= trade.target) return { side: trade.side, outcome: "win" };
    if (buy ? k.price <= trade.stop : k.price >= trade.stop) return { side: trade.side, outcome: "loss" };
    const hold = (cfg.mode === "basket" ? cfg.basketHoldSec : cfg.maxHoldSec) * 1000;
    if (k.at - trade.at > hold || (cfg.mode !== "basket" && endAt - k.at < cfg.closeBufferSec * 1000)) return { side: trade.side, outcome: "timeout" };
  }
  return trade ? { side: trade.side, outcome: "timeout" } : null;
}

const proofCache = new Map<string, { key: string; buy: CycleStats; sell: CycleStats }>();

function proof(symbol: string, tf: number, closed: Candle[], minRange: number, cfg: CandleConfig) {
  const recent = closed.slice(-cfg.historyCandles);
  const key = [recent[recent.length - 1]?.t ?? 0, cfg.entryLevel, cfg.targetLevel, cfg.stopLevel, cfg.closeBufferSec, cfg.maxHoldSec, cfg.mode, cfg.bounceFrac, cfg.stopFrac, cfg.dumpZone, cfg.basketHoldSec, Math.round(minRange * 1e8), recent.length].join("|");
  const hit = proofCache.get(`${symbol}|${tf}`);
  if (hit && hit.key === key) return hit;
  const buy: CycleStats = { events: 0, wins: 0, losses: 0, timeouts: 0 };
  const sell: CycleStats = { events: 0, wins: 0, losses: 0, timeouts: 0 };
  for (const c of recent) {
    const r = simulateCandle(c.ticks, cfg, minRange, c.t + tf * 1000);
    if (!r) continue;
    const bucket = r.side === "BUY" ? buy : sell;
    bucket.events++;
    if (r.outcome === "win") bucket.wins++;
    else if (r.outcome === "loss") bucket.losses++;
    else bucket.timeouts++;
  }
  const out = { key, buy, sell };
  proofCache.set(`${symbol}|${tf}`, out);
  return out;
}

const EMPTY: CycleStats = { events: 0, wins: 0, losses: 0, timeouts: 0 };

function empty(reason: string, ticks = 0): Assessment {
  return { ok: false, reason, signal: "skip", side: null, pos: 50, lo: 0, hi: 0, rangePct: 0, ticks, long: EMPTY, short: EMPTY, hitRate: 0, events: 0, breakEvenRate: 0, score: 0, tf: 0, instability: 0, left: 0, typRange: 0, typRangePct: 0 };
}

function analyse(symbol: string, all: Tick[], tf: number, cfg: CandleConfig): Assessment {
  const candles = buildCandles(all, tf);
  // the first candle is usually cut off by where the history starts, the last one is still live
  const closed = candles.slice(1, -1);
  const live = candles[candles.length - 1];
  const be = cfg.mode === "basket" ? breakEvenRate({ entryLevel: 0, targetLevel: cfg.bounceFrac * 100, stopLevel: -cfg.stopFrac * 100 }) : breakEvenRate(cfg);
  if (!live || closed.length < 3) return { ...empty(`Collecting ${tfLabel(tf)} candles (${closed.length}/3)`, live?.n ?? 0), tf, breakEvenRate: be };
  const recent = closed.slice(-cfg.historyCandles);
  const inst = instability(recent.concat(live.n >= 8 ? [live] : []));
  const last = live.ticks[live.ticks.length - 1]!;
  const typRange = inst.medRange;
  const minRange = Math.max(typRange * (cfg.mode === "basket" ? cfg.spikeMult : cfg.minRangeMult), (last.price * cfg.minRangePct) / 100);
  const pf = proof(symbol, tf, closed, minRange, cfg);
  const events = pf.buy.events + pf.sell.events;
  const wins = pf.buy.wins + pf.sell.wins;
  const hitRate = events ? wins / events : 0;

  const st = newSt();
  for (const k of live.ticks) push(st, k.price);
  const left = (live.t + tf * 1000 - last.at) / 1000;
  const ev = evalFor(st, cfg, minRange, left);

  const base: Assessment = {
    ok: false,
    reason: "",
    signal: "skip",
    side: null,
    pos: ev.pos,
    lo: st.lo,
    hi: st.hi,
    rangePct: ((st.hi - st.lo) / last.price) * 100,
    ticks: live.n,
    long: pf.buy,
    short: pf.sell,
    hitRate,
    events,
    breakEvenRate: be,
    score: inst.score * 0.7 + (events >= 3 ? hitRate * 30 : 0),
    tf,
    instability: inst.score,
    left,
    typRange,
    typRangePct: (typRange / last.price) * 100,
  };
  if (inst.score < cfg.minInstability) return { ...base, reason: `Calm market (instability ${inst.score.toFixed(0)}, need ${cfg.minInstability})` };
  if (!(typRange > 0)) return { ...base, reason: "Flat price" };
  if (cfg.requireProof) {
    const need = Math.max(cfg.minHitRate, be + cfg.edgeMargin);
    if (events < cfg.minEvents) return { ...base, reason: `Only ${events} ${tfLabel(tf)} setups in history (need ${cfg.minEvents})` };
    if (hitRate < need) return { ...base, reason: `Setup paid ${(hitRate * 100).toFixed(0)}% < ${(need * 100).toFixed(0)}% needed` };
  }
  return { ...base, ok: true, reason: ev.why, signal: ev.sig, side: ev.side };
}

/** Assesses one market. With timeframe 0 it tests each automatic timeframe and keeps the one whose history paid best. */
export function assessCandle(symbol: string, ticks: Tick[], cfg: CandleConfig): Assessment {
  if (ticks.length < 40) return empty(`Collecting ticks (${ticks.length}/40)`, ticks.length);
  const tfs = cfg.timeframe > 0 ? [cfg.timeframe] : AUTO_TIMEFRAMES;
  let best: Assessment | null = null;
  let bestKey = -Infinity;
  for (const tf of tfs) {
    const a = analyse(symbol, ticks, tf, cfg);
    const key = (a.events >= 3 ? a.hitRate * 100 : 0) + (a.instability ?? 0) * 0.3 + (a.tf === 60 ? 0.5 : 0);
    if (key > bestKey) {
      best = a;
      bestKey = key;
    }
  }
  return best!;
}
