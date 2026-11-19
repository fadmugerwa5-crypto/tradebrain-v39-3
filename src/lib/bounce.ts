/**
 * Jump Scalper — range-bounce strategy (pure functions, no I/O).
 *
 * Price is mapped onto a 0–100 scale inside its recent range (100 = top, 0 = bottom).
 * LONG idea:  price touches the top zone, drops back to ~80, we BUY, take profit near 90.
 * SHORT idea: the mirror image (bottom zone, bounce up to ~20, we SELL, take profit near 10).
 * A market is only traded when its own recent history shows the bounce actually worked often enough.
 */
export type Tick = { at: number; price: number };

export type BounceConfig = {
  /** price must have touched this level (0–100) to "arm" a long setup */
  peakLevel: number;
  /** buy when price has dropped back to this level */
  entryLevel: number;
  /** take profit level */
  targetLevel: number;
  /** stop level: if price falls this far the idea failed */
  stopLevel: number;
  /** how many recent ticks define the range */
  windowTicks: number;
  /** a peak older than this (seconds) no longer arms a setup */
  armWindowSec: number;
  /** trade is closed if it hasn't hit target/stop within this time */
  maxHoldSec: number;
  /** minimum finished bounce/fail cycles in the window before a market may be traded */
  minEvents: number;
  /** minimum share of cycles that reached the target */
  minHitRate: number;
  /** extra edge required above the break-even hit rate */
  edgeMargin: number;
  /** range must be at least this wide as a percent of price (else costs eat the move) */
  minRangePct: number;
  /** max drift of the range midpoint between window halves, as a share of the range (trending filter) */
  maxDrift: number;
  /**
   * Strict mode: trade only markets whose own recent history proves the bounce (enough cycles, hit rate above break-even,
   * not trending). When false, any market with a usable range may trade, and the history is shown for information only.
   */
  requireProof: boolean;
};

export const BOUNCE_DEFAULTS: BounceConfig = {
  peakLevel: 92,
  entryLevel: 80,
  targetLevel: 90,
  stopLevel: 65,
  windowTicks: 1200,
  armWindowSec: 240,
  maxHoldSec: 90,
  minEvents: 5,
  minHitRate: 0.6,
  edgeMargin: 0.05,
  minRangePct: 0.02,
  maxDrift: 0.35,
  requireProof: false,
};

export function rangeOf(ticks: Tick[]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of ticks) {
    if (t.price < lo) lo = t.price;
    if (t.price > hi) hi = t.price;
  }
  return { lo, hi, range: hi - lo };
}

export function position(price: number, lo: number, hi: number) {
  const r = hi - lo;
  return r > 0 ? ((price - lo) / r) * 100 : 50;
}

export type CycleStats = { events: number; wins: number; losses: number; timeouts: number };

/**
 * Replays a 0–100 series (already mirrored for shorts). A cycle is: reach peak -> fall to entry -> then
 * either reach target (win), reach stop (loss) or run out of time (timeout). After each cycle the
 * series must touch the peak again before a new cycle starts.
 */
export function replayCycles(series: number[], times: number[], cfg: BounceConfig): CycleStats {
  const out: CycleStats = { events: 0, wins: 0, losses: 0, timeouts: 0 };
  let state: "idle" | "armed" | "in" = "idle";
  let enteredAt = 0;
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    if (state === "idle") {
      if (s >= cfg.peakLevel) state = "armed";
    } else if (state === "armed") {
      if (s <= cfg.stopLevel) state = "idle"; // fell straight through, never offered an entry
      else if (s <= cfg.entryLevel) {
        state = "in";
        enteredAt = times[i]!;
      }
    } else {
      if (s >= cfg.targetLevel) {
        out.events++;
        out.wins++;
        state = "idle";
      } else if (s <= cfg.stopLevel) {
        out.events++;
        out.losses++;
        state = "idle";
      } else if (times[i]! - enteredAt > cfg.maxHoldSec * 1000) {
        out.events++;
        out.timeouts++;
        state = "idle";
      }
    }
  }
  return out;
}

export type Assessment = {
  ok: boolean;
  /** why a market is not tradable right now, or a short status for the UI */
  reason: string;
  /** "entry" = place a trade now, "armed" = peak seen, waiting for the drop, "watch" = qualified but idle */
  signal: "entry" | "armed" | "watch" | "skip";
  side: "BUY" | "SELL" | null;
  /** current position in the range, 0–100 */
  pos: number;
  lo: number;
  hi: number;
  rangePct: number;
  ticks: number;
  long: CycleStats;
  short: CycleStats;
  hitRate: number;
  events: number;
  breakEvenRate: number;
  /** ranking value for choosing the best markets */
  score: number;
  /** candle strategy extras: timeframe in seconds, instability 0-100, seconds left in the live candle, typical candle range */
  tf?: number;
  instability?: number;
  left?: number;
  typRange?: number;
  typRangePct?: number;
};
type Levels = Pick<BounceConfig, "entryLevel" | "targetLevel" | "stopLevel">;

const EMPTY: CycleStats = { events: 0, wins: 0, losses: 0, timeouts: 0 };

function empty(reason: string, ticks = 0): Assessment {
  return { ok: false, reason, signal: "skip", side: null, pos: 50, lo: 0, hi: 0, rangePct: 0, ticks, long: EMPTY, short: EMPTY, hitRate: 0, events: 0, breakEvenRate: 0, score: 0 };
}

export function breakEvenRate(cfg: Levels) {
  const gain = cfg.targetLevel - cfg.entryLevel;
  const loss = cfg.entryLevel - cfg.stopLevel;
  return loss / (gain + loss);
}

/** Does the live series currently show an armed setup that has dropped into the entry zone? */
function liveSetup(series: number[], times: number[], cfg: BounceConfig): "entry" | "armed" | null {
  const n = series.length;
  if (n < 5) return null;
  const now = times[n - 1]!;
  let peakIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (now - times[i]! > cfg.armWindowSec * 1000) break;
    if (series[i]! >= cfg.peakLevel) {
      peakIdx = i;
      break;
    }
  }
  if (peakIdx < 0) return null;
  for (let i = peakIdx + 1; i < n; i++) if (series[i]! <= cfg.stopLevel) return null; // already failed
  const cur = series[n - 1]!;
  if (cur >= cfg.targetLevel) return null; // already recovered, nothing left to buy
  if (cur > cfg.entryLevel) return "armed";
  if (cur <= cfg.stopLevel + 3) return "armed"; // too close to the stop to start a trade
  // first tick back up after the drop (series is already mirrored for shorts)
  return series[n - 1]! > series[n - 2]! ? "entry" : "armed";
}

export function assessBounce(allTicks: Tick[], cfg: BounceConfig = BOUNCE_DEFAULTS): Assessment {
  const ticks = allTicks.slice(-cfg.windowTicks);
  if (ticks.length < 120) return empty(`Collecting ticks (${ticks.length}/120)`, ticks.length);
  const { lo, hi, range } = rangeOf(ticks);
  const last = ticks[ticks.length - 1]!;
  if (!(range > 0) || !(last.price > 0)) return empty("Flat price", ticks.length);
  const rangePct = (range / last.price) * 100;
  const pos = position(last.price, lo, hi);
  const times = ticks.map((t) => t.at);
  const longSeries = ticks.map((t) => position(t.price, lo, hi));
  const shortSeries = longSeries.map((p) => 100 - p);
  const long = replayCycles(longSeries, times, cfg);
  const short = replayCycles(shortSeries, times, cfg);

  const base = { pos, lo, hi, rangePct, ticks: ticks.length, long, short, breakEvenRate: breakEvenRate(cfg) };
  const events = long.events + short.events;
  const wins = long.wins + short.wins;
  const hitRate = events > 0 ? wins / events : 0;
  const fail = (reason: string): Assessment => ({ ...base, ok: false, reason, signal: "skip", side: null, hitRate, events, score: 0 });

  if (rangePct < cfg.minRangePct) return fail(`Range too narrow (${rangePct.toFixed(3)}%)`);

  const need = Math.max(cfg.minHitRate, base.breakEvenRate + cfg.edgeMargin);
  if (cfg.requireProof) {
    // trending filter: midpoint of the first half vs the second half
    const half = Math.floor(ticks.length / 2);
    const a = rangeOf(ticks.slice(0, half));
    const b = rangeOf(ticks.slice(half));
    const drift = Math.abs((a.lo + a.hi) / 2 - (b.lo + b.hi) / 2) / range;
    if (drift > cfg.maxDrift) return fail(`Trending (drift ${(drift * 100).toFixed(0)}% of range)`);
    if (events < cfg.minEvents) return fail(`Only ${events} bounce cycles (need ${cfg.minEvents})`);
    if (hitRate < need) return fail(`Bounce rate ${(hitRate * 100).toFixed(0)}% < ${(need * 100).toFixed(0)}% needed`);
  }

  const score = hitRate * 100 + Math.min(events, 20);
  const lSig = liveSetup(longSeries, times, cfg);
  const sSig = liveSetup(shortSeries, times, cfg);
  const longRate = long.events ? long.wins / long.events : 0;
  const shortRate = short.events ? short.wins / short.events : 0;
  const sideOk = (n: number, rate: number) => !cfg.requireProof || (n >= Math.ceil(cfg.minEvents / 2) && rate >= need);
  const candidates: { side: "BUY" | "SELL"; sig: "entry" | "armed"; rate: number }[] = [];
  if (lSig && sideOk(long.events, longRate)) candidates.push({ side: "BUY", sig: lSig, rate: longRate });
  if (sSig && sideOk(short.events, shortRate)) candidates.push({ side: "SELL", sig: sSig, rate: shortRate });
  candidates.sort((x, y) => (x.sig === y.sig ? y.rate - x.rate : x.sig === "entry" ? -1 : 1));
  const pick = candidates[0];
  if (!pick) return { ...base, ok: true, reason: events ? `Waiting for a peak · ${events} past bounces` : "Waiting for a peak", signal: "watch", side: null, hitRate, events, score };
  return {
    ...base,
    ok: true,
    reason: pick.sig === "entry" ? `${pick.side} setup: dropped to the entry zone, first tick back` : `${pick.side} armed: peak seen, waiting for the drop`,
    signal: pick.sig,
    side: pick.side,
    hitRate,
    events,
    score,
  };
}

export type TradePlan = {
  /** position size in account money (stake x multiplier) */
  notional: number;
  /** expected gross gain if the target is hit, in account money */
  grossTarget: number;
  /** money lost if the stop is hit */
  stopLoss: number;
  /** expected net gain after the cost estimate */
  expectedNet: number;
  moveFrac: number;
  stopFrac: number;
};

/**
 * Sizes a trade so that hitting the target pays `targetNetUsd` after costs, but never risks more than `maxLossUsd`.
 * `costFrac` is the estimated round-trip cost as a fraction of position size (commission + slippage).
 * Returns null when the move is too small to beat costs or the net gain would be below `minNetUsd`.
 */
export function planTrade(args: {
  price: number;
  lo: number;
  hi: number;
  cfg: Levels;
  targetNetUsd: number;
  maxLossUsd: number;
  minNetUsd: number;
  costFrac: number;
}): TradePlan | null {
  const { price, lo, hi, cfg, targetNetUsd, maxLossUsd, minNetUsd, costFrac } = args;
  const range = hi - lo;
  if (!(price > 0) || !(range > 0)) return null;
  const moveFrac = ((cfg.targetLevel - cfg.entryLevel) / 100) * (range / price);
  const stopFrac = ((cfg.entryLevel - cfg.stopLevel) / 100) * (range / price);
  const netFrac = moveFrac - costFrac;
  if (!(netFrac > 0)) return null;
  const wanted = targetNetUsd / netFrac;
  const capped = maxLossUsd / (stopFrac + costFrac);
  const notional = Math.min(wanted, capped);
  const expectedNet = notional * netFrac;
  if (expectedNet < minNetUsd) return null;
  return { notional, grossTarget: notional * moveFrac, stopLoss: notional * stopFrac, expectedNet, moveFrac, stopFrac };
}

/**
 * Chooses a Deriv multiplier and stake for a wanted position size. The stop loss must fit inside the stake,
 * and Deriv stakes have a minimum. Returns the final notional (stake x multiplier), which may be larger than wanted
 * when the minimum stake forces it.
 */
export function pickMultiplier(options: number[], notional: number, stopLoss: number, minStake = 1): { mult: number; stake: number; notional: number } | null {
  const opts = [...new Set(options.filter((m) => m > 0))].sort((a, b) => b - a);
  if (!opts.length || !(notional > 0)) return null;
  for (const m of opts) {
    const stake = notional / m;
    if (stake >= minStake && stake >= stopLoss * 1.1) return { mult: m, stake: Math.round(stake * 100) / 100, notional: Math.round(stake * 100) * m / 100 };
  }
  // nothing fits: smallest multiplier with the minimum stake (position becomes larger than wanted)
  const m = opts[opts.length - 1]!;
  const stake = Math.max(minStake, Math.ceil(stopLoss * 1.1 * 100) / 100);
  return { mult: m, stake, notional: stake * m };
}

export type ClosedTrade = { symbol: string; pnl: number };

export function summarizeTrades(trades: ClosedTrade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const gross = wins.reduce((s, t) => s + t.pnl, 0);
  const lost = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : 0,
    avgWin: wins.length ? gross / wins.length : 0,
    avgLoss: losses.length ? -lost / losses.length : 0,
    net: gross - lost,
    profitFactor: lost > 0 ? gross / lost : gross > 0 ? Infinity : 0,
  };
}

/** Per-market history of real trades: a market with a poor record is skipped. */
export function marketBlocked(trades: ClosedTrade[], symbol: string, minTrades = 8, minWinRate = 0.4) {
  const mine = trades.filter((t) => t.symbol === symbol).slice(-20);
  if (mine.length < minTrades) return false;
  return mine.filter((t) => t.pnl > 0).length / mine.length < minWinRate;
}
