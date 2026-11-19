import { useState } from "react";
import { clearHistory, clearJournal, select, type Basket, type ClosedTrade, type JournalEntry, type Position, type Row } from "@/engine";
import { summarizeTrades } from "@/lib/bounce";
import { tfLabel } from "@/lib/candle";
import { hub } from "@/lib/ticks";
import { useStore } from "@/ui";

export const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const stamp = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The candle "jumping": the last minute of price as a small moving line. */
function Spark({ symbol, w = 92, h = 30 }: { symbol: string; w?: number; h?: number }) {
  const t = hub.get(symbol).slice(-70);
  if (t.length < 5) return <div style={{ width: w, height: h }} />;
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of t) {
    lo = Math.min(lo, k.price);
    hi = Math.max(hi, k.price);
  }
  const r = hi - lo || 1;
  const pts = t.map((k, i) => `${((i / (t.length - 1)) * w).toFixed(1)},${(h - 2 - ((k.price - lo) / r) * (h - 4)).toFixed(1)}`).join(" ");
  const up = t[t.length - 1]!.price >= t[0]!.price;
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? "#0f9d78" : "#dd4f58"} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function RangeBar({ pos, cfg }: { pos: number; cfg: { mode: "basket" | "pullback"; entryLevel: number; targetLevel: number; stopLevel: number; dumpZone: number } }) {
  const marks = cfg.mode === "basket" ? [cfg.dumpZone, 100 - cfg.dumpZone, 0, 100] : [cfg.stopLevel, cfg.entryLevel, cfg.targetLevel, 100];
  return (
    <div className="relative mt-2 h-2.5 rounded-full bg-elev-2">
      {cfg.mode === "basket" ? (
        <>
          <div className="absolute inset-y-0 rounded-full bg-up/25" style={{ left: 0, width: `${cfg.dumpZone}%` }} />
          <div className="absolute inset-y-0 rounded-full bg-down/20" style={{ right: 0, width: `${cfg.dumpZone}%` }} />
        </>
      ) : (
        <>
          <div className="absolute inset-y-0 rounded-full bg-up/20" style={{ left: `${cfg.entryLevel}%`, width: `${cfg.targetLevel - cfg.entryLevel}%` }} />
          <div className="absolute inset-y-0 rounded-full bg-down/15" style={{ left: `${cfg.stopLevel}%`, width: `${cfg.entryLevel - cfg.stopLevel}%` }} />
        </>
      )}
      {marks.map((l) => (
        <span key={l} className="absolute top-[-2px] h-3.5 w-px bg-faint" style={{ left: `${l}%` }} />
      ))}
      <span className="absolute top-[-3px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-white bg-accent shadow" style={{ left: `${Math.max(0, Math.min(100, pos))}%` }} />
    </div>
  );
}

function pill(r: Row): [string, string] {
  if (r.open) return ["IN TRADE", "bg-accent text-accent-fg"];
  if (r.tradable === "no") return ["NO MULTIPLIER", "bg-elev-2 text-faint"];
  if (r.viable === false) return ["TOO COSTLY", "bg-elev-2 text-faint"];
  if (r.a.signal === "entry") return [`${r.a.side} NOW`, r.a.side === "BUY" ? "bg-up text-white" : "bg-down text-white"];
  if (r.a.signal === "armed") return [`${r.a.side} ARMED`, "bg-warn/20 text-warn"];
  if (r.a.signal === "watch") return ["WAIT", "bg-aqua/20 text-fg"];
  return ["SKIP", "bg-elev-2 text-faint"];
}

export function Scanner({ rows, onOpen }: { rows: Row[]; onOpen: (symbol: string) => void }) {
  const cfg = useStore().settings;
  const [f, setF] = useState<"all" | "ready" | "hot">("all");
  const list = rows.filter((r) => r.a.ticks >= 1).filter((r) => (f === "all" ? true : f === "ready" ? r.a.ok : r.a.signal === "armed" || r.a.signal === "entry" || r.open)).slice(0, 80);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {([["all", "All"], ["ready", "Ready"], ["hot", "Armed / Entry"]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setF(id)} className={`h-9 rounded-full px-4 text-xs ${f === id ? "bg-accent text-accent-fg" : "glass text-muted"}`}>{label}</button>
        ))}
      </div>
      <p className="text-xs text-muted">Live: the number is where price sits inside the CURRENT candle (100 = its highest point so far, 0 = its lowest). Markets are sorted with the most unstable candles first. In basket mode the green zone at the bottom is where a BUY basket opens after a dump, the red zone at the top is where a SELL basket opens after a pump. Tap a market for its chart.</p>
      {list.length === 0 && <p className="glass rounded-lg p-4 text-sm text-muted">Nothing to show yet. Markets appear as ticks arrive.</p>}
      {list.map((r) => {
        const [label, cls] = pill(r);
        return (
          <button key={r.symbol} type="button" onClick={() => onOpen(r.symbol)} className="glass rounded-lg p-3 text-left">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.label}{r.tradable === "no" ? <span className="ml-1 text-xs text-faint">· no multipliers</span> : null}</div>
                <div className="truncate text-xs text-muted">{r.a.reason}</div>
                {r.edge && <div className={`truncate text-xs ${r.viable === false ? "text-down" : "text-faint"}`}>{r.edge}</div>}
              </div>
              <Spark symbol={r.symbol} />
              <div className="w-14 text-right">
                <div className="text-xl font-semibold tabular-nums leading-none">{r.a.hi > r.a.lo ? r.a.pos.toFixed(0) : "–"}</div>
                <div className="text-[10px] text-faint">of 100</div>
              </div>
            </div>
            {r.a.hi > r.a.lo && <RangeBar pos={r.a.pos} cfg={cfg} />}
            <div className="mt-2 flex items-center justify-between text-xs text-muted">
              <span className={`rounded-full px-2 py-0.5 ${cls}`}>{label}</span>
              <span>{r.a.tf ? `${tfLabel(r.a.tf)} · unstable ${Math.round(r.a.instability ?? 0)} · ${Math.max(0, Math.round(r.a.left ?? 0))}s left` : ""}{r.a.events > 0 ? ` · ${Math.round(r.a.hitRate * 100)}% of ${r.a.events} paid` : ""}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function Markets({ rows, positions, onOpen }: { rows: Row[]; positions: Position[]; onOpen: (s: string) => void }) {
  const watched = rows.filter((r) => r.top && !r.open);
  const noMult = rows.filter((r) => r.tradable === "no").length;
  const line = (r: Row, extra?: string) => (
    <button key={r.symbol} type="button" onClick={() => onOpen(r.symbol)} className="glass flex items-center gap-3 rounded-lg px-3 py-2 text-left">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{r.label}</div>
        <div className="truncate text-xs text-muted">{extra ?? r.a.reason}</div>
      </div>
      <Spark symbol={r.symbol} w={70} h={24} />
      <span className="w-9 text-right text-lg font-semibold tabular-nums">{r.a.hi > r.a.lo ? r.a.pos.toFixed(0) : "–"}</span>
    </button>
  );
  const inTrade = rows.filter((r) => r.open);
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Being traded now ({positions.length})</h2>
      {inTrade.length === 0 && <p className="text-sm text-muted">No open trades.</p>}
      {inTrade.map((r) => {
        const p = positions.find((x) => x.symbol === r.symbol);
        return line(r, p ? `${p.side} · stake ${p.stake} x${p.mult} · ${p.livePnl == null ? "…" : money(p.livePnl)}` : undefined);
      })}
      <h2 className="mt-2 text-sm font-semibold">Watched: best {watched.length} markets</h2>
      {watched.length === 0 && <p className="text-sm text-muted">No market is ready yet. History is still loading, or none show a usable range.</p>}
      {watched.map((r) => line(r))}
      <p className="mt-2 text-xs text-muted">{rows.length} markets loaded from Deriv. {noMult > 0 ? `${noMult} can't be traded because Deriv sells no multiplier contracts on them.` : ""}</p>
    </div>
  );
}

export function ChartView({ rows, positions, selected }: { rows: Row[]; positions: Position[]; selected: string }) {
  const cfg = useStore().settings;
  const sym = selected || rows[0]?.symbol || "";
  const row = rows.find((r) => r.symbol === sym);
  const tfMs = (row?.a.tf || 60) * 1000;
  const all = hub.get(sym);
  const lastAt = all[all.length - 1]?.at ?? 0;
  const liveStart = Math.floor(lastAt / tfMs) * tfMs;
  // the live candle plus the one before it, so you see the candle you are trading in context
  const t = all.filter((k) => k.at >= liveStart - tfMs);
  const liveIdx = t.findIndex((k) => k.at >= liveStart);
  const W = 340;
  const H = 230;
  const body = (() => {
    if (!row || t.length < 10 || row.a.hi <= row.a.lo) return <p className="text-sm text-muted">Waiting for ticks on this market…</p>;
    const { lo, hi } = row.a;
    const own = positions.filter((p) => p.symbol === sym);
    const vals = [...t.map((k) => k.price), lo, hi, ...own.map((p) => p.entryPrice)];
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const y = (p: number) => 8 + (1 - (p - mn) / (mx - mn || 1)) * (H - 16);
    const x = (i: number) => (i / (t.length - 1)) * W;
    const at = (lvl: number) => lo + (lvl / 100) * (hi - lo);
    const pts = t.map((k, i) => `${x(i).toFixed(1)},${y(k.price).toFixed(1)}`).join(" ");
    const sell = row.a.side === "SELL";
    // levels of the LIVE candle: 100 = high so far, 0 = low so far (for SELL the mirror levels apply)
    const m = (l: number) => (sell ? 100 - l : l);
    const levels: [number, string, string][] = cfg.mode === "basket"
      ? [[100, "100 high", "#8196ab"], [0, "0 low", "#8196ab"], [cfg.dumpZone, "buy zone", "#0f9d78"], [100 - cfg.dumpZone, "sell zone", "#dd4f58"]]
      : [[100, "100 high", "#8196ab"], [0, "0 low", "#8196ab"], [m(cfg.entryLevel), sell ? "sell entry" : "buy entry", "#0f9d78"], [m(cfg.targetLevel), "target", "#22b4d4"], [m(cfg.stopLevel), "stop", "#dd4f58"]];
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {liveIdx > 0 && <line x1={x(liveIdx)} x2={x(liveIdx)} y1="0" y2={H} stroke="#8196ab" strokeDasharray="2 3" strokeWidth="1" />}
        {levels.map(([l, name, c]) => (
          <g key={name}>
            <line x1="0" x2={W} y1={y(at(l))} y2={y(at(l))} stroke={c} strokeDasharray="4 4" strokeWidth="1" opacity="0.8" />
            <text x={W - 2} y={y(at(l)) - 2} textAnchor="end" fontSize="9" fill={c}>{name}</text>
          </g>
        ))}
        {own.map((p) => <line key={p.id} x1="0" x2={W} y1={y(p.entryPrice)} y2={y(p.entryPrice)} stroke="#123a6b" strokeWidth="1.5" />)}
        <polyline points={pts} fill="none" stroke="#123a6b" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx={x(t.length - 1)} cy={y(t[t.length - 1]!.price)} r="3.5" fill="#22b4d4" />
      </svg>
    );
  })();
  return (
    <div className="flex flex-col gap-3">
      <select value={sym} onChange={(e) => select(e.target.value)} className="h-11 rounded-md border border-line bg-elev px-3 text-sm">
        {rows.map((r) => <option key={r.symbol} value={r.symbol}>{r.label}</option>)}
      </select>
      <div className="glass rounded-lg p-3">
        {body}
        {row && (
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span>Live candle position {row.a.hi > row.a.lo ? row.a.pos.toFixed(0) : "–"} / 100{row.a.tf ? ` · ${tfLabel(row.a.tf)} candle` : ""}</span>
            <span>{pill(row)[0]}</span>
          </div>
        )}
      </div>
      <p className="text-xs text-muted">Dashed lines are drawn on the LIVE candle: 100 is its high so far, 0 its low so far. The dotted vertical line is where the live candle opened (the candle before it is on the left). Dark horizontal line = your open trade's entry.</p>
    </div>
  );
}

export function Trades({ positions, baskets, scale }: { positions: Position[]; baskets: Basket[]; scale: number }) {
  const loose = positions.filter((p) => !p.basketId);
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Open baskets ({baskets.length}) · next size x{scale}</h2>
      {baskets.length === 0 && <p className="glass rounded-lg p-4 text-sm text-muted">No open baskets. Watch the status line at the top for what the bot is waiting for.</p>}
      {baskets.map((b) => {
        const legs = positions.filter((p) => p.basketId === b.id);
        return (
          <div key={b.id} className="glass rounded-lg p-3 text-sm">
            <div className="flex justify-between">
              <span className="font-medium">{b.side} basket · {b.label}</span>
              <span className={`text-lg font-semibold ${b.livePnl == null ? "text-muted" : b.livePnl >= 0 ? "text-up" : "text-down"}`}>{b.livePnl == null ? "…" : money(b.livePnl)}</span>
            </div>
            <div className="mt-1 text-xs text-muted">{b.opening ? "opening entries…" : `${legs.length} of ${b.legsOpened} entries still open`} · closes all at {money(b.target)} or {money(-b.maxLoss)} · size x{b.scale} · {Math.round((Date.now() - b.openedAt) / 1000)}s{b.closing ? " · closing…" : ""}</div>
            <div className="text-xs text-muted">Entered at {b.entryPrice} · stake {b.stake.toFixed(2)} in total · Deriv cost {b.cost.toFixed(2)}</div>
          </div>
        );
      })}
      <h2 className="mt-2 text-sm font-semibold">Single trades ({loose.length})</h2>
      {loose.length === 0 && <p className="text-sm text-muted">None.</p>}
      {loose.map((p) => (
        <div key={p.id} className="glass rounded-lg p-3 text-sm">
          <div className="flex justify-between">
            <span className="font-medium">{p.side} {p.label}</span>
            <span className={`text-lg font-semibold ${p.livePnl == null ? "text-muted" : p.livePnl >= 0 ? "text-up" : "text-down"}`}>{p.livePnl == null ? "…" : money(p.livePnl)}</span>
          </div>
          <div className="mt-1 text-xs text-muted">Stake {p.stake} x{p.mult} · target {money(p.takeProfit)} · stop {money(-p.stopLoss)} · opened {clock(p.openedAt)} · {Math.round((Date.now() - p.openedAt) / 1000)}s{p.closing ? " · closing…" : ""}</div>
        </div>
      ))}
    </div>
  );
}

function Cell({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="glass rounded-lg p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

const KIND: Record<JournalEntry["kind"], string> = { info: "text-muted", trade: "text-up", skip: "text-warn", error: "text-down" };

export function Journal({ trades, journal, day }: { trades: ClosedTrade[]; journal: JournalEntry[]; day: number }) {
  const [view, setView] = useState<"trades" | "events">("trades");
  const real = trades.filter((t) => !t.test);
  const m = summarizeTrades(real);
  const bySym = [...new Set(real.map((t) => t.symbol))].map((sym) => ({ label: real.find((t) => t.symbol === sym)!.label, ...summarizeTrades(real.filter((t) => t.symbol === sym)) })).sort((a, b) => b.net - a.net);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Cell label="Closed trades" value={String(m.trades)} />
        <Cell label="Win rate" value={m.trades ? `${(m.winRate * 100).toFixed(0)}%` : "—"} />
        <Cell label="Average win" value={m.wins ? money(m.avgWin) : "—"} tone="text-up" />
        <Cell label="Average loss" value={m.losses ? money(m.avgLoss) : "—"} tone="text-down" />
        <Cell label="Net after costs" value={money(m.net)} tone={m.net >= 0 ? "text-up" : "text-down"} />
        <Cell label="Profit factor" value={m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)} />
        <Cell label="Today" value={money(day)} tone={day >= 0 ? "text-up" : "text-down"} />
        <Cell label="Best market" value={bySym[0] ? bySym[0].label : "—"} />
      </div>
      <p className="text-xs text-muted">Judge the strategy after a few hundred demo trades, not a handful. Profit factor above 1 after costs means the wins outweigh the losses.</p>
      <div className="flex gap-2">
        {([["trades", "Trade journal"], ["events", "Event log"]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setView(id)} className={`h-9 rounded-full px-4 text-xs ${view === id ? "bg-accent text-accent-fg" : "glass text-muted"}`}>{label}</button>
        ))}
      </div>
      {view === "trades" && (
        <>
          {trades.length === 0 && <p className="glass rounded-lg p-4 text-sm text-muted">No closed trades yet. Every trade is written here with its entry level, result and why it closed.</p>}
          {[...trades].reverse().slice(0, 100).map((t) => (
            <div key={`${t.id}-${t.closedAt}`} className="glass rounded-lg p-3 text-sm">
              <div className="flex justify-between">
                <span className="font-medium">{t.side} {t.label}</span>
                <span className={`font-semibold ${t.pnl >= 0 ? "text-up" : "text-down"}`}>{money(t.pnl)}</span>
              </div>
              <div className="mt-1 text-xs text-muted">{stamp(t.openedAt)} · held {Math.round((t.closedAt - t.openedAt) / 1000)}s · {t.exitReason}</div>
              <div className="text-xs text-muted">Entered at range {t.entryPos.toFixed(0)} · stake {t.stake} x{t.mult} · expected {money(t.expectedNet)} · Deriv cost {t.cost.toFixed(2)}</div>
            </div>
          ))}
          {trades.length > 0 && <button type="button" className="h-11 rounded-md border border-line text-sm text-muted" onClick={() => window.confirm("Delete all recorded trades?") && clearHistory()}>Clear trade journal</button>}
        </>
      )}
      {view === "events" && (
        <>
          {journal.length === 0 && <p className="glass rounded-lg p-4 text-sm text-muted">Nothing logged yet.</p>}
          {journal.map((j, i) => (
            <div key={`${j.at}-${i}`} className="glass rounded-lg px-3 py-2 text-xs">
              <span className="text-faint">{clock(j.at)} </span>
              <span className={KIND[j.kind]}>{j.text}</span>
            </div>
          ))}
          {journal.length > 0 && <button type="button" className="h-11 rounded-md border border-line text-sm text-muted" onClick={() => clearJournal()}>Clear event log</button>}
        </>
      )}
    </div>
  );
}

