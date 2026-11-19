import { marketBlocked, pickMultiplier, planTrade, summarizeTrades, type Assessment } from "@/lib/bounce";
import { nextScale, planBasket } from "@/lib/basket";
import { assessCandle, CANDLE_DEFAULTS, tfLabel, type CandleConfig } from "@/lib/candle";
import { deriv, type MarketInfo } from "@/lib/deriv";
import { setKeepAlive } from "@/lib/keepalive";
import { createStore, loadJson, saveJson } from "@/lib/store";
import { hub } from "@/lib/ticks";

export type Settings = CandleConfig & {
  /** money we want to net when the target is hit */
  targetNetUsd: number;
  /** the most one trade may lose at its stop */
  maxLossUsd: number;
  /** skip trades whose expected net gain is below this */
  minNetUsd: number;
  /** estimated round-trip cost as a fraction of position size (Deriv's real quote is checked before buying) */
  costFrac: number;
  /** trades open at the same time (pullback mode) */
  maxOpen: number;
  /** baskets open at the same time (basket mode) */
  maxBaskets: number;
  /** only the N most unstable (best) qualified markets are traded */
  watchTop: number;
  /** trading stops for the day after losing this much */
  dailyLossUsd: number;
  /** wait this long before re-entering the same market */
  cooldownSec: number;
  token: string;
  appId: string;
};

export const SETTINGS_DEFAULTS: Settings = {
  ...CANDLE_DEFAULTS,
  targetNetUsd: 1.5,
  maxLossUsd: 3,
  minNetUsd: 0.5,
  costFrac: 0.0003,
  maxOpen: 5,
  maxBaskets: 2,
  watchTop: 10,
  dailyLossUsd: 10,
  cooldownSec: 120,
  token: "",
  appId: "",
};

export type Position = {
  id: string;
  symbol: string;
  label: string;
  side: "BUY" | "SELL";
  openedAt: number;
  stake: number;
  mult: number;
  notional: number;
  entryPrice: number;
  entryPos: number;
  stopLoss: number;
  takeProfit: number;
  expectedNet: number;
  cost: number;
  livePnl: number | null;
  /** local time (ms) when the candle this trade was opened on closes; the trade is sold shortly before */
  closeAt?: number;
  tf?: number;
  /** set when this contract is one leg of a basket */
  basketId?: string;
  closing?: boolean;
  closeReason?: string;
  /** a manual $1 pipeline check, not a strategy trade: excluded from statistics */
  test?: boolean;
};

/** Several entries opened together on one market and closed together on the bounce. */
export type Basket = {
  id: string;
  symbol: string;
  label: string;
  side: "BUY" | "SELL";
  openedAt: number;
  entryPrice: number;
  entryPos: number;
  tf?: number;
  legsWanted: number;
  legsOpened: number;
  /** still sending the orders */
  opening: boolean;
  stake: number;
  mult: number;
  notional: number;
  cost: number;
  /** basket closes when its total profit reaches this */
  target: number;
  /** basket closes when its total loss reaches this */
  maxLoss: number;
  /** size multiplier this basket was opened with */
  scale: number;
  /** profit of legs that already closed */
  pnl: number;
  /** live profit of the whole basket (closed legs + open legs) */
  livePnl: number | null;
  closing?: boolean;
  reason?: string;
};

export type ClosedTrade = Position & { closedAt: number; pnl: number; exitReason: string };

export type Row = { symbol: string; label: string; group: string; a: Assessment; blockedUntil: number; open: boolean; top: boolean; tradable: "yes" | "no" | "?"; /** false when the expected move cannot beat Deriv's cost; null while the cost is unmeasured */ viable: boolean | null; /** "move 0.020% · cost 0.035%" */ edge: string };
export type JournalEntry = { at: number; kind: "info" | "trade" | "skip" | "error"; text: string };

type State = {
  settings: Settings;
  trading: boolean;
  status: "idle" | "loading" | "ready" | "error";
  error: string;
  account: { connected: boolean; loginid: string; balance: number | null; currency: string; virtual: boolean };
  feed: { connected: boolean; markets: number; withHistory: number };
  rows: Row[];
  positions: Position[];
  baskets: Basket[];
  /** basket size multiplier: grows after wins, resets after a loss */
  scale: number;
  trades: ClosedTrade[];
  journal: JournalEntry[];
  /** market shown on the Chart tab */
  selected: string;
  /** plain-language reason nothing is being traded right now */
  blocker: string;
  note: string;
  dayPnl: number;
};

const SETTINGS_KEY = "jump-scalper-settings-v3";
const OLD_SETTINGS_KEY = "jump-scalper-settings-v2";
const TRADES_KEY = "jump-scalper-trades-v2";
const OPEN_KEY = "jump-scalper-open-v2";
const JOURNAL_KEY = "jump-scalper-journal-v2";
const BASKETS_KEY = "jump-scalper-baskets-v1";
const SCALE_KEY = "jump-scalper-scale-v1";

const today = () => new Date().toISOString().slice(0, 10);
const loaded = (() => {
  // the v2 strategy had different levels, so only the connection details are carried over
  const old = loadJson<{ token: string; appId: string }>(OLD_SETTINGS_KEY, { token: "", appId: "" });
  const merged = loadJson<Settings>(SETTINGS_KEY, { ...SETTINGS_DEFAULTS, token: old.token, appId: old.appId });
  return merged;
})();
const savedTrades = (() => {
  try {
    const raw = localStorage.getItem(TRADES_KEY);
    return raw ? (JSON.parse(raw) as ClosedTrade[]).slice(-2000) : [];
  } catch {
    return [];
  }
})();
const savedOpen = (() => {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw ? (JSON.parse(raw) as Position[]) : [];
  } catch {
    return [];
  }
})();

const savedBaskets = (() => {
  try {
    const raw = localStorage.getItem(BASKETS_KEY);
    return raw ? (JSON.parse(raw) as Basket[]).map((b) => ({ ...b, opening: false, closing: false })) : [];
  } catch {
    return [];
  }
})();
const savedScale = (() => {
  try {
    const n = Number(localStorage.getItem(SCALE_KEY));
    return n >= 1 ? n : 1;
  } catch {
    return 1;
  }
})();

const savedJournal = (() => {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return raw ? (JSON.parse(raw) as JournalEntry[]).slice(0, 300) : [];
  } catch {
    return [];
  }
})();

export const store = createStore<State>({
  settings: loaded,
  trading: false,
  status: "idle",
  error: "",
  account: { connected: false, loginid: "", balance: null, currency: "USD", virtual: true },
  feed: { connected: false, markets: 0, withHistory: 0 },
  rows: [],
  positions: savedOpen,
  baskets: savedBaskets,
  scale: savedScale,
  trades: savedTrades,
  journal: savedJournal,
  selected: "",
  blocker: "",
  note: "",
  dayPnl: savedTrades.filter((t) => new Date(t.closedAt).toISOString().slice(0, 10) === today()).reduce((s, t) => s + t.pnl, 0),
});

let markets: MarketInfo[] = [];
const cooldown = new Map<string, number>();
const noMultiplier = new Map<string, number>();
let busy = false;
let timers: ReturnType<typeof setInterval>[] = [];

/** Levels the money sizing uses: basket = bounce/stop as shares of the candle range from the entry; pullback = candle levels. */
const planLevels = (cfg: Settings) => (cfg.mode === "basket" ? { entryLevel: 0, targetLevel: cfg.bounceFrac * 100, stopLevel: -cfg.stopFrac * 100 } : { entryLevel: cfg.entryLevel, targetLevel: cfg.targetLevel, stopLevel: cfg.stopLevel });

function log(text: string, kind: JournalEntry["kind"] = "info") {
  store.set((s) => ({ journal: [{ at: Date.now(), kind, text }, ...s.journal].slice(0, 300) }));
  saveJson(JOURNAL_KEY, store.get().journal);
}

export function clearJournal() {
  store.set({ journal: [] });
  saveJson(JOURNAL_KEY, []);
}

export function select(symbol: string) {
  store.set({ selected: symbol });
}

const tradable = new Map<string, boolean>();
/** Deriv's real round-trip cost per market, as a fraction of position size, measured from its own quote. */
const costs = new Map<string, number>();
/** Small allowance for slippage on top of Deriv's quoted commission. */
const SLIPPAGE = 0.00005;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function measureCost(symbol: string): Promise<number | null> {
  const known = costs.get(symbol);
  if (known != null) return known;
  const opts = await deriv.multiplierOptions(symbol).catch(() => null);
  if (!opts?.length) return null;
  const mult = opts[Math.floor(opts.length / 2)]!;
  const stake = 10;
  try {
    const q = await deriv.quoteMultiplier(symbol, stake, store.get().account.currency, mult);
    const frac = q.commission / (stake * mult);
    costs.set(symbol, frac);
    return frac;
  } catch {
    return null;
  }
}

/** After connecting: ask Deriv what trading each market really costs, so markets whose swings are too small are marked instead of tried. */
async function probeCosts() {
  for (const m of markets) {
    if (tradable.get(m.symbol) === false) continue;
    await measureCost(m.symbol);
    await sleep(200);
  }
  const rows = store.get().rows.filter((r) => r.viable != null);
  log(`Cost check done for ${costs.size} markets: ${rows.filter((r) => r.viable).length} of ${rows.length} currently have a price swing big enough to beat Deriv's cost.`);
}

export function patchSettings(p: Partial<Settings>) {
  const settings = { ...store.get().settings, ...p };
  store.set({ settings });
  saveJson(SETTINGS_KEY, settings);
}

function persist() {
  const s = store.get();
  saveJson(TRADES_KEY, s.trades.slice(-2000));
  saveJson(OPEN_KEY, s.positions);
  saveJson(BASKETS_KEY, s.baskets);
  saveJson(SCALE_KEY, s.scale);
}

/** Loads every Deriv market, starts the public tick feed and fills the scanner with recent history. */
export async function start() {
  if (store.get().status === "loading" || store.get().status === "ready") return;
  store.set({ status: "loading", error: "" });
  try {
    markets = (await deriv.markets()).filter((m) => m.open);
    if (!markets.length) throw new Error("Deriv returned no open markets.");
    hub.start(markets.map((m) => m.symbol));
    store.set({ status: "ready", feed: { connected: false, markets: markets.length, withHistory: 0 } });
    log(`Loaded ${markets.length} Deriv markets from Deriv's public feed (no login needed to watch). Filling history…`);
    void seedHistory();
    void probeTradable();
    timers.forEach(clearInterval);
    timers = [setInterval(() => void cycle(), 1000), setInterval(() => void poll(), 1000)];
    const { token, appId } = store.get().settings;
    if (token && appId) await connect();
  } catch (e) {
    store.set({ status: "error", error: e instanceof Error ? e.message : "Could not start." });
  }
}

async function seedHistory() {
  let n = 0;
  for (const m of markets) {
    try {
      hub.seed(m.symbol, await deriv.tickHistory(m.symbol, 3600));
      n++;
      if (n % 5 === 0) store.set((s) => ({ feed: { ...s.feed, withHistory: n } }));
    } catch {
      /* this market simply starts empty and fills from the live feed */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  store.set((s) => ({ feed: { ...s.feed, withHistory: n } }));
  log(`History ready for ${n} markets.`);
}

/** Which markets sell multiplier contracts. Public data, so it works before you log in. */
async function probeTradable() {
  for (const m of markets) {
    try {
      tradable.set(m.symbol, !!(await deriv.multiplierOptions(m.symbol)));
    } catch {
      /* unknown: tried again at entry time */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const yes = [...tradable.values()].filter(Boolean).length;
  log(`Multiplier check done: ${yes} of ${tradable.size} markets can be traded.`);
}

export async function connect() {
  const { token, appId } = store.get().settings;
  if (!token || !appId) {
    store.set({ error: "Enter your Deriv token and App ID in Settings." });
    return;
  }
  try {
    const r = await deriv.authorize(token.trim(), appId.trim());
    store.set({ account: { connected: true, loginid: r.loginid, balance: r.balance, currency: r.currency, virtual: r.virtual }, error: "" });
    if (!r.virtual) {
      store.set({ trading: false, error: "This is a REAL account. Jump Scalper trades demo accounts only, so trading is blocked." });
      log("Real account detected. Trading blocked (demo only).", "error");
    } else {
      log(`Connected to Deriv demo account ${r.loginid}. Balance ${r.balance} ${r.currency}.`);
      void probeCosts();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not connect.";
    store.set({ account: { ...store.get().account, connected: false }, error: msg });
    log(`Connect failed: ${msg}`, "error");
  }
}

export function setTrading(on: boolean) {
  const s = store.get();
  if (on && !(s.account.connected && s.account.virtual)) {
    store.set({ error: s.account.connected ? "Demo accounts only." : "Connect your Deriv demo account first (Settings tab)." });
    return;
  }
  store.set({ trading: on, error: "" });
  void setKeepAlive(on);
  log(on ? "Trading ON (demo)." : "Trading OFF. Open trades keep their stop and target.");
}

function slotsFull(s: State) {
  return s.settings.mode === "basket" ? s.baskets.length >= s.settings.maxBaskets : s.positions.length >= s.settings.maxOpen;
}

function openSymbols() {
  return new Set(store.get().positions.map((p) => p.symbol));
}

async function cycle() {
  const s = store.get();
  const cfg = s.settings;
  const now = Date.now();
  // a basket whose legs are all gone (closed while the app was off) is written to the journal and frees its slot
  for (const b of s.baskets) if (!b.opening && !s.positions.some((p) => p.basketId === b.id)) completeBasketIfDone(b.id);
  const open = openSymbols();
  const rows: Row[] = markets.map((m) => {
    const a = assessCandle(m.symbol, hub.get(m.symbol), cfg);
    const price = hub.last(m.symbol)?.price ?? 0;
    let viable: boolean | null = null;
    let edge = "";
    if (a.ok && price > 0 && (a.typRange ?? 0) > 0) {
      // viability uses the TYPICAL candle size, so a market doesn't flicker while a fresh candle is still tiny
      const typ = a.typRange!;
      const L = planLevels(cfg);
      const moveFrac = ((L.targetLevel - L.entryLevel) / 100) * (typ / price);
      const c = costs.get(m.symbol);
      if (c != null) {
        const used = c + SLIPPAGE;
        viable = planTrade({ price, lo: price - typ / 2, hi: price + typ / 2, cfg: L, targetNetUsd: cfg.targetNetUsd, maxLossUsd: cfg.maxLossUsd, minNetUsd: cfg.minNetUsd, costFrac: used }) != null;
        edge = `typical ${tfLabel(a.tf ?? 60)} candle move ${(moveFrac * 100).toFixed(3)}% · Deriv cost ${(used * 100).toFixed(3)}%`;
      } else edge = `typical ${tfLabel(a.tf ?? 60)} candle move ${(moveFrac * 100).toFixed(3)}% · cost not measured yet`;
    }
    return { symbol: m.symbol, label: m.label, group: m.group, a, blockedUntil: Math.max(cooldown.get(m.symbol) ?? 0, noMultiplier.get(m.symbol) ?? 0), open: open.has(m.symbol), top: false, tradable: tradable.has(m.symbol) ? (tradable.get(m.symbol) ? "yes" : "no") : "?", viable, edge } as Row;
  });
  const prio = (r: Row) => (r.a.signal === "entry" ? 3 : r.a.signal === "armed" ? 2 : r.a.signal === "watch" ? 1 : 0);
  rows.sort((x, y) => prio(y) - prio(x) || y.a.score - x.a.score);
  const qualified = rows.filter((r) => r.a.ok && r.tradable !== "no" && r.viable !== false && !marketBlocked(s.trades.filter((t) => !t.test), r.symbol)).sort((x, y) => y.a.score - x.a.score);
  const topSet = new Set(qualified.slice(0, cfg.watchTop).map((r) => r.symbol));
  rows.forEach((r) => (r.top = topSet.has(r.symbol)));
  const armed = rows.filter((r) => r.top && r.a.signal === "armed").length;
  const blocker = !hub.connected ? "Live price feed is reconnecting…"
    : !s.trading ? "Trading is paused. Tap “Start trading”."
    : !s.account.connected ? "Not connected to your Deriv demo account (Settings → Connect)."
    : slotsFull(s) ? `All ${cfg.mode === "basket" ? cfg.maxBaskets : cfg.maxOpen} ${cfg.mode === "basket" ? "basket" : "trade"} slots are in use.`
    : qualified.length === 0 ? "No unstable market has candles big enough to beat Deriv's trading cost right now (see the numbers on each Scanner card)."
    : armed ? `Waiting: ${armed} unstable market${armed > 1 ? "s" : ""} ${cfg.mode === "basket" ? "spiking, waiting for the candle extreme and the first tick back" : `pulling back toward ${cfg.entryLevel}`}.`
    : cfg.mode === "basket" ? "Waiting for a live candle to spike and dump to its low (or pump to its high)."
    : "Waiting for a live candle to make a move and pull back.";
  store.set({ rows, blocker, feed: { ...s.feed, connected: hub.connected }, note: `${qualified.length} qualified · trading the best ${Math.min(cfg.watchTop, qualified.length)} · ${cfg.mode === "basket" ? `${s.baskets.length}/${cfg.maxBaskets} baskets` : `${s.positions.length}/${cfg.maxOpen} open`}` });

  if (!s.trading || busy || !s.account.connected || !s.account.virtual) return;
  if (s.dayPnl <= -cfg.dailyLossUsd) {
    store.set({ trading: false, error: `Daily loss limit reached (${s.dayPnl.toFixed(2)}). Trading stopped for today.` });
    void setKeepAlive(false);
    log("Daily loss limit reached. Trading stopped.", "error");
    return;
  }
  if (slotsFull(s)) return;
  const next = rows.find((r) => r.a.signal === "entry" && r.top && !r.open && r.blockedUntil < now && hub.connected && now - (hub.last(r.symbol)?.at ?? 0) < 8000);
  if (!next) return;
  busy = true;
  try {
    await (cfg.mode === "basket" ? enterBasket(next) : enter(next));
  } finally {
    busy = false;
  }
}

async function enter(r: Row) {
  const s = store.get();
  const cfg = s.settings;
  const side = r.a.side!;
  const price = hub.last(r.symbol)!.price;
  const skip = (why: string, ms = 60_000) => {
    cooldown.set(r.symbol, Date.now() + ms);
    log(`${r.label}: ${why}`, "skip");
  };
  const opts = await deriv.multiplierOptions(r.symbol).catch(() => null);
  if (!opts) {
    noMultiplier.set(r.symbol, Date.now() + 6 * 3_600_000);
    tradable.set(r.symbol, false);
    log(`${r.label}: Deriv offers no multiplier here. Skipped for 6 hours.`, "skip");
    return;
  }
  const measured = await measureCost(r.symbol);
  const costFrac = (measured ?? cfg.costFrac) + SLIPPAGE;
  // level of the live candle where we are actually entering (mirrored for SELL so 100 is always the extreme we pull back from)
  const entryAt = side === "BUY" ? r.a.pos : 100 - r.a.pos;
  const levels = { entryLevel: entryAt, targetLevel: cfg.targetLevel, stopLevel: cfg.stopLevel };
  const plan = planTrade({ price, lo: r.a.lo, hi: r.a.hi, cfg: levels, targetNetUsd: cfg.targetNetUsd, maxLossUsd: cfg.maxLossUsd, minNetUsd: cfg.minNetUsd, costFrac });
  if (!plan) {
    const moveFrac = ((cfg.targetLevel - entryAt) / 100) * (r.a.rangePct / 100);
    return skip(`expected move ${(moveFrac * 100).toFixed(3)}% does not beat Deriv's cost ${(costFrac * 100).toFixed(3)}%${measured == null ? " (estimated, no quote)" : ""}`, 120_000);
  }
  const m = pickMultiplier(opts, plan.notional, plan.stopLoss, 1);
  if (!m) return skip("no usable multiplier");
  const notional = m.notional;
  const stopLoss = notional * plan.stopFrac;
  const takeProfit = notional * plan.moveFrac;
  if (stopLoss > cfg.maxLossUsd * 1.25) return skip(`minimum stake would risk ${stopLoss.toFixed(2)} (limit ${cfg.maxLossUsd})`, 300_000);
  if (m.stake < stopLoss * 1.05) return skip("stake too small for the stop loss");
  const bal = s.account.balance;
  if (bal != null && m.stake > bal * 0.25) return skip("stake is more than 25% of the balance");
  try {
    const res = await deriv.multiplier(r.symbol, side, m.stake, s.account.currency, m.mult, stopLoss, takeProfit, { expectedGross: takeProfit, minNet: cfg.minNetUsd });
    const pos: Position = { id: res.contractId, symbol: r.symbol, label: r.label, side, openedAt: Date.now(), stake: m.stake, mult: m.mult, notional, entryPrice: price, entryPos: entryAt, stopLoss, takeProfit, expectedNet: takeProfit - res.cost, cost: res.cost, livePnl: null, tf: r.a.tf, closeAt: Date.now() + (r.a.left ?? 0) * 1000 };
    store.set((st) => ({ positions: [...st.positions, pos], account: { ...st.account, balance: deriv.balance } }));
    persist();
    cooldown.set(r.symbol, Date.now() + cfg.cooldownSec * 1000);
    log(`OPENED ${side} ${r.label} on the ${tfLabel(r.a.tf ?? 60)} candle, pullback to ${entryAt.toFixed(0)} of 100 · stake ${m.stake} x${m.mult} · target +${takeProfit.toFixed(2)} · stop -${stopLoss.toFixed(2)} · Deriv cost ${res.cost.toFixed(2)}`, "trade");
  } catch (e) {
    skip(e instanceof Error ? e.message : "order failed", 90_000);
  }
}

/** One basket entry: opens `legs` contracts together on the same market. The poll loop closes them all together. */
async function enterBasket(r: Row) {
  const s = store.get();
  const cfg = s.settings;
  const side = r.a.side!;
  const price = hub.last(r.symbol)!.price;
  const skip = (why: string, ms = 60_000) => {
    cooldown.set(r.symbol, Date.now() + ms);
    log(`${r.label}: ${why}`, "skip");
  };
  const opts = await deriv.multiplierOptions(r.symbol).catch(() => null);
  if (!opts) {
    noMultiplier.set(r.symbol, Date.now() + 6 * 3_600_000);
    tradable.set(r.symbol, false);
    log(`${r.label}: Deriv offers no multiplier here. Skipped for 6 hours.`, "skip");
    return;
  }
  const measured = await measureCost(r.symbol);
  const costFrac = (measured ?? cfg.costFrac) + SLIPPAGE;
  const scale = s.scale;
  const plan = planBasket({ price, range: r.a.hi - r.a.lo, bounceFrac: cfg.bounceFrac, stopFrac: cfg.stopFrac, legs: Math.min(10, cfg.legs), targetUsd: cfg.targetNetUsd * scale, maxLossUsd: cfg.maxLossUsd * scale, minNetUsd: cfg.minNetUsd, costFrac, options: opts });
  if (!plan.ok) return skip(plan.why, 120_000);
  const totalStake = plan.legs.reduce((t, l) => t + l.stake, 0);
  const bal = s.account.balance;
  if (bal != null && totalStake > bal * 0.5) return skip(`basket stakes (${totalStake.toFixed(2)}) are more than 50% of the balance`, 300_000);

  const id = `b${Date.now()}`;
  const leg0 = plan.legs[0]!;
  const basket: Basket = { id, symbol: r.symbol, label: r.label, side, openedAt: Date.now(), entryPrice: price, entryPos: r.a.pos, tf: r.a.tf, legsWanted: plan.legs.length, legsOpened: 0, opening: true, stake: 0, mult: leg0.mult, notional: 0, cost: 0, target: plan.targetNet, maxLoss: plan.maxLoss, scale, pnl: 0, livePnl: null };
  store.set((st) => ({ baskets: [...st.baskets, basket] }));
  cooldown.set(r.symbol, Date.now() + cfg.cooldownSec * 1000);

  // all entries go out together, like pressing buy several times at the same price
  const results = await Promise.allSettled(plan.legs.map((leg) => deriv.multiplier(r.symbol, side, leg.stake, s.account.currency, leg.mult, leg.stopLoss, leg.takeProfit)));
  const opened: Position[] = [];
  const errors: string[] = [];
  results.forEach((res, i) => {
    const leg = plan.legs[i]!;
    if (res.status === "fulfilled") opened.push({ id: res.value.contractId, symbol: r.symbol, label: r.label, side, openedAt: Date.now(), stake: leg.stake, mult: leg.mult, notional: leg.notional, entryPrice: price, entryPos: r.a.pos, stopLoss: leg.stopLoss, takeProfit: leg.takeProfit, expectedNet: plan.targetNet / plan.legs.length, cost: res.value.cost, livePnl: null, basketId: id, tf: r.a.tf });
    else errors.push(res.reason instanceof Error ? res.reason.message : "order failed");
  });
  if (!opened.length) {
    store.set((st) => ({ baskets: st.baskets.filter((b) => b.id !== id) }));
    return skip(errors[0] ?? "no leg was accepted", 90_000);
  }
  const share = opened.length / plan.legs.length;
  store.set((st) => ({
    positions: [...st.positions, ...opened],
    account: { ...st.account, balance: deriv.balance },
    baskets: st.baskets.map((b) => (b.id === id ? { ...b, opening: false, legsOpened: opened.length, stake: opened.reduce((t, p) => t + p.stake, 0), notional: opened.reduce((t, p) => t + p.notional, 0), cost: opened.reduce((t, p) => t + p.cost, 0), target: b.target * share, maxLoss: b.maxLoss * share } : b)),
  }));
  persist();
  log(`BASKET ${side} ${r.label}: ${opened.length}/${plan.legs.length} entries at ${price} on the ${tfLabel(r.a.tf ?? 60)} candle (spike ${r.a.pos.toFixed(0)} of 100) · closes all at +${(plan.targetNet * share).toFixed(2)} or -${(plan.maxLoss * share).toFixed(2)} · size x${scale}${errors.length ? ` · ${errors.length} entries refused: ${errors[0]}` : ""}`, "trade");
}

function finish(p: Position, pnl: number, reason: string) {
  if (p.basketId) return finishLeg(p, pnl, reason);
  const closed: ClosedTrade = { ...p, closedAt: Date.now(), pnl, exitReason: reason, livePnl: pnl };
  const day = !p.test && new Date(closed.closedAt).toISOString().slice(0, 10) === today();
  store.set((st) => ({ positions: st.positions.filter((x) => x.id !== p.id), trades: [...st.trades, closed].slice(-2000), dayPnl: st.dayPnl + (day ? pnl : 0) }));
  persist();
  cooldown.set(p.symbol, Date.now() + (pnl < 0 ? 2 : 1) * store.get().settings.cooldownSec * 1000);
  log(`CLOSED ${p.label} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${reason})`, "trade");
  void deriv.refreshBalance().then((b) => store.set((st) => ({ account: { ...st.account, balance: b } })));
}

/** A basket leg ended (sold by us or by Deriv's own stop/target). When the last leg is gone the basket is written to the journal as ONE trade. */
function finishLeg(p: Position, pnl: number, reason: string) {
  const b = store.get().baskets.find((x) => x.id === p.basketId);
  store.set((st) => ({ positions: st.positions.filter((x) => x.id !== p.id), baskets: st.baskets.map((x) => (x.id === p.basketId ? { ...x, pnl: x.pnl + pnl, reason: x.reason ?? reason } : x)) }));
  if (!b) {
    // the basket record is gone (older session): keep the leg as an ordinary trade
    const closed: ClosedTrade = { ...p, closedAt: Date.now(), pnl, exitReason: reason, livePnl: pnl, basketId: undefined };
    store.set((st) => ({ trades: [...st.trades, closed].slice(-2000), dayPnl: st.dayPnl + pnl }));
    persist();
    return;
  }
  completeBasketIfDone(b.id);
}

function completeBasketIfDone(id: string) {
  const st0 = store.get();
  const b = st0.baskets.find((x) => x.id === id);
  if (!b || b.opening || st0.positions.some((x) => x.basketId === id)) return;
  const cfg = st0.settings;
  const closed: ClosedTrade = { id: b.id, symbol: b.symbol, label: `${b.label} basket x${b.legsOpened}`, side: b.side, openedAt: b.openedAt, stake: b.stake, mult: b.mult, notional: b.notional, entryPrice: b.entryPrice, entryPos: b.entryPos, stopLoss: b.maxLoss, takeProfit: b.target, expectedNet: b.target, cost: b.cost, livePnl: b.pnl, closedAt: Date.now(), pnl: b.pnl, exitReason: b.reason ?? (b.pnl > 0 ? "basket target" : "basket stop") };
  const won = b.pnl > 0;
  const scale = nextScale(st0.scale, won, cfg.scaleStep, cfg.scaleMax);
  const day = new Date(closed.closedAt).toISOString().slice(0, 10) === today();
  store.set((st) => ({ baskets: st.baskets.filter((x) => x.id !== id), trades: [...st.trades, closed].slice(-2000), dayPnl: st.dayPnl + (day ? b.pnl : 0), scale }));
  persist();
  cooldown.set(b.symbol, Date.now() + (won ? 1 : 2) * cfg.cooldownSec * 1000);
  log(`BASKET CLOSED ${b.label} ${b.pnl >= 0 ? "+" : ""}${b.pnl.toFixed(2)} (${closed.exitReason}) · next size x${scale}`, "trade");
  void deriv.refreshBalance().then((bal) => store.set((s2) => ({ account: { ...s2.account, balance: bal } })));
}

async function sellNow(p: Position, reason: string) {
  if (p.closing) return;
  store.set((st) => ({ positions: st.positions.map((x) => (x.id === p.id ? { ...x, closing: true, closeReason: reason } : x)) }));
  try {
    await deriv.sell(p.id);
  } catch (e) {
    log(`${p.label}: could not sell yet (${e instanceof Error ? e.message : "error"}). Will retry.`, "error");
    store.set((st) => ({ positions: st.positions.map((x) => (x.id === p.id ? { ...x, closing: false } : x)) }));
  }
}

/** Sells every leg of a basket at once. */
async function closeBasket(b: Basket, reason: string) {
  if (b.closing) return;
  store.set((st) => ({ baskets: st.baskets.map((x) => (x.id === b.id ? { ...x, closing: true, reason } : x)) }));
  log(`Closing basket ${b.label}: ${reason} (${b.livePnl == null ? "…" : (b.livePnl >= 0 ? "+" : "") + b.livePnl.toFixed(2)})`, "trade");
  await Promise.all(store.get().positions.filter((p) => p.basketId === b.id).map((p) => sellNow(p, reason)));
  // any leg Deriv would not sell is retried on the next check
  store.set((st) => ({ baskets: st.baskets.map((x) => (x.id === b.id ? { ...x, closing: false } : x)) }));
}

let polling = false;

async function poll() {
  const s = store.get();
  if (polling || !s.account.connected || !s.positions.length) return;
  polling = true;
  try {
    const checked = await Promise.all(
      s.positions.map(async (p) => {
        try {
          return [p, await deriv.contractStatus(p.id)] as const;
        } catch {
          return [p, null] as const; // network hiccup: try again next poll
        }
      }),
    );
    for (const [p, c] of checked) {
      if (!c) continue;
      if (c.is_sold === 1 || c.status === "won" || c.status === "lost") {
        const pnl = Number(c.profit ?? (c.sell_price ?? 0) - (c.buy_price ?? p.stake));
        const live = store.get().positions.find((x) => x.id === p.id);
        finish(p, pnl, live?.closeReason ?? (pnl > 0 ? "target hit" : "stop hit"));
        continue;
      }
      const pnl = c.profit != null ? Number(c.profit) : null;
      store.set((st) => ({ positions: st.positions.map((x) => (x.id === p.id ? { ...x, livePnl: pnl } : x)) }));
      if (!p.basketId && !p.closing && c.is_valid_to_sell !== 0) {
        if (!p.test && p.closeAt && Date.now() >= p.closeAt - s.settings.closeBufferSec * 1000) await sellNow(p, "candle closing");
        else if (Date.now() - p.openedAt > s.settings.maxHoldSec * 1000) await sellNow(p, "time limit");
      }
    }
    // basket manager: one total profit for the whole stack, closed together
    const cfg = store.get().settings;
    for (const b of store.get().baskets) {
      if (b.opening) continue;
      const legs = store.get().positions.filter((p) => p.basketId === b.id);
      if (!legs.length) {
        completeBasketIfDone(b.id);
        continue;
      }
      if (legs.some((p) => p.livePnl == null)) continue;
      const total = b.pnl + legs.reduce((t, p) => t + (p.livePnl ?? 0), 0);
      store.set((st) => ({ baskets: st.baskets.map((x) => (x.id === b.id ? { ...x, livePnl: total } : x)) }));
      const fresh = { ...b, livePnl: total };
      if (total >= b.target) await closeBasket(fresh, "basket target");
      else if (total <= -b.maxLoss) await closeBasket(fresh, "basket stop");
      else if (Date.now() - b.openedAt > cfg.basketHoldSec * 1000) await closeBasket(fresh, "time limit");
    }
  } finally {
    polling = false;
  }
}

export async function closeAll() {
  for (const p of store.get().positions) await sellNow(p, "closed by you");
}

export function clearHistory() {
  store.set({ trades: [], dayPnl: 0 });
  persist();
}

export const stats = () => summarizeTrades(store.get().trades.filter((t) => !t.test));

/** Places one $1 demo multiplier trade right now so you can see that orders reach your Deriv demo account. */
export async function testTrade() {
  const s = store.get();
  if (!s.account.connected) return log("Test trade: connect your Deriv demo account first.", "error");
  if (!s.account.virtual) return log("Test trade blocked: real account.", "error");
  const pick = s.selected && s.rows.find((r) => r.symbol === s.selected && r.tradable !== "no") ? s.selected : s.rows.find((r) => r.tradable === "yes" && hub.last(r.symbol))?.symbol;
  if (!pick) return log("Test trade: no market with multipliers found yet. Wait a few seconds for the multiplier check.", "error");
  const label = markets.find((m) => m.symbol === pick)?.label ?? pick;
  try {
    const opts = await deriv.multiplierOptions(pick);
    if (!opts?.length) throw new Error("no multipliers on this market");
    const mult = opts[0]!;
    const price = hub.last(pick)?.price ?? 0;
    const res = await deriv.multiplier(pick, "BUY", 1, s.account.currency, mult, 0.8, 0.6);
    const pos: Position = { id: res.contractId, symbol: pick, label: `TEST ${label}`, side: "BUY", openedAt: Date.now(), stake: 1, mult, notional: mult, entryPrice: price, entryPos: 0, stopLoss: 0.8, takeProfit: 0.6, expectedNet: 0.6 - res.cost, cost: res.cost, livePnl: null, test: true };
    store.set((st) => ({ positions: [...st.positions, pos], account: { ...st.account, balance: deriv.balance } }));
    persist();
    log(`TEST order accepted by Deriv on ${label}: stake 1 x${mult}, contract ${res.contractId}. It will close at +0.60, -0.80 or after ${s.settings.maxHoldSec}s.`, "trade");
  } catch (e) {
    log(`TEST order REJECTED by Deriv on ${label}: ${e instanceof Error ? e.message : "unknown error"}`, "error");
  }
}
